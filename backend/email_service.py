"""
TropiCare Email Service
-----------------------
Small, self-contained SMTP sender used for account email verification.

Kept in its own module (rather than inline in main.py) so the SMTP
provider can be swapped (Gmail SMTP + App Password, Brevo SMTP, etc.)
without touching any route or business logic. Every function here is
defensive: SMTP failures are caught, logged, and never propagate as
unhandled exceptions into a request path. Email delivery is a trust
signal for this app, not a hard requirement, so a misconfigured or
unreachable provider must never block signup or lock anyone out.
"""

from __future__ import annotations

import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

logger = logging.getLogger("tropicare")

TEAL = "#0c8a7e"
TEAL_DARK = "#074d47"


def _build_verification_email(
    to_name: str, verify_url: str, from_name: str
) -> MIMEMultipart:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Verify your TropiCare account"
    msg["From"] = from_name

    text_body = (
        f"Hello {to_name},\n\n"
        "Please verify your TropiCare account by opening the link below:\n\n"
        f"{verify_url}\n\n"
        "This link expires in 24 hours. If you did not create a TropiCare "
        "account, you can safely ignore this email.\n\n"
        "TropiCare - Symptom Checker for Tropical Diseases\n"
    )

    html_body = f"""\
<html>
  <body style="margin:0;padding:0;background-color:#f4f7f9;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0"
                 style="background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #dde4ea;">
            <tr>
              <td style="background-color:{TEAL};padding:28px 32px;">
                <span style="color:#ffffff;font-size:20px;font-weight:700;">TropiCare</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="font-size:15px;color:#0b1726;line-height:1.6;margin:0 0 16px;">
                  Hello {to_name},
                </p>
                <p style="font-size:14px;color:#324154;line-height:1.6;margin:0 0 24px;">
                  Please confirm this is your email address to secure your TropiCare account.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:10px;background-color:{TEAL};">
                      <a href="{verify_url}"
                         style="display:inline-block;padding:13px 28px;color:#ffffff;
                                font-size:14px;font-weight:700;text-decoration:none;">
                        Verify Email Address
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="font-size:12px;color:#5b6b7c;line-height:1.6;margin:24px 0 0;">
                  Or copy and paste this link into your browser:<br>
                  <a href="{verify_url}" style="color:{TEAL_DARK};word-break:break-all;">{verify_url}</a>
                </p>
                <p style="font-size:12px;color:#90a0ae;line-height:1.6;margin:24px 0 0;">
                  This link expires in 24 hours. If you did not create a TropiCare account,
                  you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""

    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))
    return msg


def send_verification_email(
    to_email: str,
    to_name: str,
    token: str,
    frontend_url: str,
    smtp_host: str,
    smtp_port: int,
    smtp_user: str,
    smtp_password: str,
    smtp_from_name: str,
    smtp_from_email: Optional[str] = None,
) -> bool:
    """
    Sends the verification email synchronously. Intended to be called from
    a FastAPI BackgroundTasks job (via run_in_executor) so it never blocks
    or fails the request that triggered it. Returns True/False rather than
    raising, so callers can log/metric the result without try/except.
    """
    if not smtp_user or not smtp_password:
        logger.info({"event": "email_skip", "reason": "smtp not configured"})
        return False

    from_email = smtp_from_email or smtp_user
    from_header = f"{smtp_from_name} <{from_email}>"
    verify_url = f"{frontend_url.rstrip('/')}/?verify={token}"

    try:
        msg = _build_verification_email(to_name or "there", verify_url, from_header)
        msg["To"] = to_email

        with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
            server.starttls()
            server.login(smtp_user, smtp_password)
            server.sendmail(from_email, [to_email], msg.as_string())

        logger.info({"event": "verification_email_sent", "to": to_email})
        return True
    except Exception as e:
        logger.warning({"event": "verification_email_failed", "to": to_email, "error": str(e)})
        return False
