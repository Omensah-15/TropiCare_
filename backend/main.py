"""
TropiCare API
"""

from __future__ import annotations

# -----------------------------------------------------------------
# STDLIB
# -----------------------------------------------------------------
import asyncio
import hashlib
import json
import logging
import math
import os
import re
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

# -----------------------------------------------------------------
# THIRD-PARTY
# -----------------------------------------------------------------
import aiohttp
import numpy as np
from dotenv import load_dotenv
from jose import JWTError, jwt
from pythonjsonlogger import jsonlogger

from fastapi import (
    BackgroundTasks,
    Body,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from pydantic import BaseModel, EmailStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    event,
    inspect,
    text,
)
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from prometheus_fastapi_instrumentator import Instrumentator
from prometheus_client import Counter, Gauge, Histogram

from apscheduler.schedulers.asyncio import AsyncIOScheduler

import pybreaker

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileModifiedEvent

try:
    import joblib
    JOBLIB_AVAILABLE = True
except ImportError:
    JOBLIB_AVAILABLE = False

try:
    import aioredis
    AIOREDIS_AVAILABLE = True
except ImportError:
    AIOREDIS_AVAILABLE = False

load_dotenv()

# -----------------------------------------------------------------
# CONFIG
# -----------------------------------------------------------------

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    secret_key: str               = "tropicare-fallback-secret-2024"
    algorithm: str                = "HS256"
    access_token_expire_days: int = 7
    database_url: str             = "sqlite:///./tropicare.db"
    allowed_origins: str          = "*"
    port: int                     = 8000

    admin_user_id: int = 1

    openrouter_api_key: str = ""
    openrouter_url: str     = "https://openrouter.ai/api/v1/chat/completions"
    openrouter_model: str   = "mistralai/mistral-7b-instruct:free"
    site_url: str           = "http://localhost:8000"
    site_name: str          = "TropiCare"

    redis_url: str = "redis://localhost:6379/0"

    enable_ai_cache: bool      = True
    enable_rate_limiting: bool = True
    async_mode: bool           = True

    db_pool_min: int = 5
    db_pool_max: int = 20

    max_body_size: int = 5 * 1024 * 1024

    # -------------------------------------------------------------
    # SOCIAL SIGN-IN
    # -------------------------------------------------------------
    # google_client_id must match the OAuth 2.0 Web Client ID used by the
    # frontend's Google Identity Services flow (see App.jsx GOOGLE_CLIENT_ID).
    #
    # facebook_app_id / facebook_app_secret come from developers.facebook.com;
    # the secret is used server-side only, to validate tokens via the
    # /debug_token endpoint. Never ship the secret to the frontend.
    #
    # apple_client_id is the Services ID (e.g. "com.tropicare.web") used by
    # Sign in with Apple JS. Apple ID tokens are verified against Apple's
    # published JWKS, so no Apple secret is needed here.
    google_client_id: str    = ""
    facebook_app_id: str     = ""
    facebook_app_secret: str = ""
    apple_client_id: str     = ""

    # -------------------------------------------------------------
    # CLINIC FINDER (GEOAPIFY)
    # -------------------------------------------------------------
    # Used by the /api/v1/clinics/nearby route to query Geoapify's Places
    # API for nearby hospitals, clinics, pharmacies, and dentists/doctors'
    # offices. Read from the GEOAPIFY_API_KEY environment variable; get a
    # free-tier key at https://www.geoapify.com/. If left blank, the route
    # logs a geoapify_error and falls back to the curated facility list.
    geoapify_api_key: str = ""

    # -------------------------------------------------------------
    # PASSWORD RESET EMAIL (SMTP)
    # -------------------------------------------------------------
    # Standard SMTP so any provider works -- Gmail/Workspace, Outlook,
    # SendGrid, Mailgun, Postmark and Amazon SES (via its SMTP interface)
    # all accept these same five settings. Leave smtp_host blank in
    # development: /auth/forgot-password then logs the reset link instead
    # of emailing it, so the flow still works end to end locally with no
    # mail server configured.
    smtp_host:      str = ""
    smtp_port:      int = 587
    smtp_username:  str = ""
    smtp_password:  str = ""
    smtp_use_tls:   bool = True
    # Shown as the email's "From" name/address. Falls back to smtp_username
    # when blank, since most providers require the From address to match
    # (or be verified against) the authenticated account anyway.
    smtp_from_email: str = ""
    smtp_from_name:  str = "TropiCare"

    # Public URL of the deployed frontend (e.g. https://tropicare.vercel.app)
    # -- used to build the link inside the password reset email. Must be
    # set in production; the localhost default only makes sense when
    # running the Vite dev server locally.
    frontend_url: str = "http://localhost:5173"

    # How long a password reset link stays valid before the user has to
    # request a new one.
    password_reset_token_expire_minutes: int = 30

    @property
    def origins_list(self) -> list[str]:
        raw = self.allowed_origins.strip()
        if raw == "*":
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]


settings = Settings()
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

# -----------------------------------------------------------------
# LOGGING
# -----------------------------------------------------------------

def _build_logger(name: str) -> logging.Logger:
    handler = logging.StreamHandler()
    formatter = jsonlogger.JsonFormatter(
        fmt="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    handler.setFormatter(formatter)
    log = logging.getLogger(name)
    log.setLevel(logging.INFO)
    log.handlers = [handler]
    log.propagate = False
    return log


logger = _build_logger("tropicare")

# -----------------------------------------------------------------
# PROMETHEUS METRICS
# -----------------------------------------------------------------

OPENROUTER_LATENCY = Histogram(
    "tropicare_openrouter_latency_seconds",
    "OpenRouter call duration",
    buckets=[0.1, 0.5, 1, 2, 5, 10, 15],
)
OPENROUTER_ERRORS = Counter(
    "tropicare_openrouter_errors_total",
    "OpenRouter error count",
    ["reason"],
)
CACHE_HITS   = Counter("tropicare_cache_hits_total",   "Redis cache hits",   ["key_type"])
CACHE_MISSES = Counter("tropicare_cache_misses_total",  "Redis cache misses", ["key_type"])
CB_STATE     = Gauge("tropicare_circuit_breaker_open",  "Circuit breaker open (1=open)")
DB_POOL_ACTIVE = Gauge("tropicare_db_pool_active", "DB pool active connections")
DB_POOL_IDLE   = Gauge("tropicare_db_pool_idle",   "DB pool idle connections")
SESSION_CLEANUP_RUNS = Counter("tropicare_session_cleanup_runs_total", "Session cleanup scheduler runs")
SCHEMA_MIGRATIONS_APPLIED = Counter(
    "tropicare_schema_migrations_applied_total",
    "Columns added to existing tables at startup",
    ["table", "column"],
)
CLINIC_SOURCE_ERRORS = Counter(
    "tropicare_clinic_source_errors_total",
    "Clinic data source failures",
    ["source", "reason"],
)

# -----------------------------------------------------------------
# REDIS
# -----------------------------------------------------------------

_redis: Optional[Any] = None


async def get_redis() -> Optional[Any]:
    global _redis
    if not AIOREDIS_AVAILABLE or not settings.enable_ai_cache:
        return None
    if _redis is None:
        try:
            _redis = await aioredis.from_url(
                settings.redis_url,
                encoding="utf-8",
                decode_responses=True,
                max_connections=20,
            )
            await _redis.ping()
        except Exception as e:
            logger.warning({"event": "redis_connect_failed", "error": str(e)})
            _redis = None
    return _redis


async def cache_get(key: str, key_type: str = "generic") -> Optional[str]:
    r = await get_redis()
    if r is None:
        return None
    try:
        val = await r.get(key)
        if val is not None:
            CACHE_HITS.labels(key_type=key_type).inc()
        else:
            CACHE_MISSES.labels(key_type=key_type).inc()
        return val
    except Exception:
        return None


async def cache_set(key: str, value: str, ttl: int) -> None:
    r = await get_redis()
    if r is None:
        return
    try:
        await r.setex(key, ttl, value)
    except Exception:
        pass


async def cache_delete(key: str) -> None:
    r = await get_redis()
    if r is None:
        return
    try:
        await r.delete(key)
    except Exception:
        pass


# -----------------------------------------------------------------
# DATABASE
# -----------------------------------------------------------------

_connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

_pool_kwargs: dict = {}
if not settings.database_url.startswith("sqlite"):
    _pool_kwargs = {
        "pool_size":     settings.db_pool_min,
        "max_overflow":  settings.db_pool_max - settings.db_pool_min,
        "pool_pre_ping": True,
    }

engine = create_engine(
    settings.database_url,
    connect_args=_connect_args,
    **_pool_kwargs,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


@event.listens_for(engine, "checkout")
def _on_checkout(dbapi_conn, conn_record, conn_proxy):
    try:
        pool = engine.pool
        DB_POOL_ACTIVE.set(getattr(pool, "_checked_out", 0))
        idle_queue = getattr(pool, "_pool", None)
        DB_POOL_IDLE.set(idle_queue.qsize() if idle_queue is not None else 0)
    except Exception:
        # Pool internals vary by SQLAlchemy pool implementation (e.g. SQLite's
        # StaticPool/NullPool do not expose the same attributes as QueuePool).
        # Metrics are best-effort and must never break a real DB checkout.
        pass


# -----------------------------------------------------------------
# ORM MODELS
# -----------------------------------------------------------------

class UserModel(Base):
    __tablename__ = "users"
    id            = Column(Integer, primary_key=True, index=True)
    email         = Column(String(255), unique=True, index=True, nullable=False)
    name          = Column(String(255), nullable=False)
    pw_hash       = Column(String(512), nullable=True)
    age           = Column(String(10), nullable=True)
    gender        = Column(String(20), nullable=True)
    # Set the first time a user signs in via Google/Facebook/Apple.
    # NULL for accounts created with an email + password only.
    auth_provider = Column(String(20), nullable=True)
    oauth_sub     = Column(String(255), nullable=True)
    # "patient" (default, self-screening individual) or "worker" (a health
    # worker who can register patients and run assessments on their behalf).
    # NOT NULL with a default so every pre-existing row remains valid with
    # no backfill required.
    role          = Column(String(20), nullable=False, default="patient")
    created_at    = Column(DateTime, default=datetime.utcnow)


class PatientModel(Base):
    """
    A patient entered by a health worker (role="worker"). Distinct from
    UserModel: a PatientModel row has no login of its own -- it exists only
    so a worker can run and track assessments on someone else's behalf.
    """
    __tablename__ = "patients"

    id                 = Column(Integer, primary_key=True, index=True)
    worker_id          = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name               = Column(String(255), nullable=False)
    age                = Column(Integer, nullable=True)
    gender             = Column(String(20), nullable=True)
    community          = Column(String(255), nullable=True)
    consent_given      = Column(Boolean, nullable=False, default=False)
    consent_timestamp  = Column(DateTime, nullable=True)
    created_at         = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_patients_worker_created", "worker_id", "created_at"),
    )


class DiagnosisModel(Base):
    __tablename__ = "diagnoses"

    id                    = Column(Integer, primary_key=True, index=True)
    user_id               = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id            = Column(String(64), index=True)
    disease               = Column(String(100))
    risk                  = Column(String(20))
    confidence            = Column(Float)
    answers               = Column(Text)
    active_symptoms       = Column(Text)
    rec_home_care         = Column(Text, nullable=True)
    rec_test              = Column(Text, nullable=True)
    rec_doctor            = Column(Text, nullable=True)
    rec_safety            = Column(Text, nullable=True)
    rec_red_flags         = Column(Text, nullable=True)
    ai_explanation        = Column(Text, nullable=True)
    ml_scores             = Column(Text, nullable=True)
    confidence_trajectory = Column(Text, nullable=True)
    # Additive metadata only: who the assessment was ABOUT, when a worker
    # ran it on behalf of a registered patient. user_id keeps its unchanged
    # meaning -- the authenticated account that owns/ran the record. NULL
    # here means today's self-screening flow, byte-for-byte unchanged.
    patient_id            = Column(Integer, ForeignKey("patients.id"), nullable=True)
    created_at            = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_diagnoses_user_created", "user_id", "created_at"),
        Index("ix_diagnoses_user_risk",    "user_id", "risk"),
    )


class SessionModel(Base):
    __tablename__ = "assessment_sessions"

    id              = Column(Integer, primary_key=True, index=True)
    session_id      = Column(String(64), unique=True, index=True)
    user_id         = Column(Integer, ForeignKey("users.id"), nullable=False)
    answers         = Column(Text, default="{}")
    asked_questions = Column(Text, default="[]")
    trajectory      = Column(Text, default="[]")
    completed       = Column(Boolean, default=False)
    # Same additive-nullable rule as DiagnosisModel.patient_id above.
    patient_id      = Column(Integer, ForeignKey("patients.id"), nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_sessions_user_completed", "user_id", "completed"),
    )


class PasswordResetTokenModel(Base):
    """
    A single-use, expiring token issued when a user requests a password
    reset. The raw token is emailed to the user and never stored -- only
    its SHA-256 hash lives here, so a leaked database (unlike a leaked
    email) can't be used to reset anyone's password. Looked up by
    token_hash, scoped by expires_at/used_at so a link only ever works
    once, within its window, and requesting a new one invalidates the
    ones before it (see /auth/forgot-password).
    """
    __tablename__ = "password_reset_tokens"

    id         = Column(Integer, primary_key=True, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String(64), unique=True, index=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    used_at    = Column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_pw_reset_user_used", "user_id", "used_at"),
    )


# -----------------------------------------------------------------
# SCHEMA AUTO-MIGRATION
#
# This project does not use Alembic. Base.metadata.create_all() only creates
# tables that do not exist yet -- it silently does NOT add new columns to
# tables that already exist in the live database. That mismatch is exactly
# what caused `trajectory` (assessment_sessions) and `confidence_trajectory`
# (diagnoses) to be missing on Render/Neon after being added to the ORM
# models here, which made every INSERT touching those columns fail and get
# swallowed by the frontend's offline fallback -- so results displayed
# correctly in the UI but were never actually persisted, and history/records
# stayed empty.
#
# This function inspects the live table definitions at startup and adds any
# column that exists on the ORM model but not in the actual table, so future
# column additions can never silently break persistence again. It is
# defensive: each column is added in its own try/except so one failure does
# not block startup or other migrations.
# -----------------------------------------------------------------

def run_schema_migrations() -> None:
    try:
        inspector = inspect(engine)
        existing_tables = set(inspector.get_table_names())
    except Exception as e:
        logger.error({"event": "schema_migration_inspect_failed", "error": str(e)})
        return

    for model in (UserModel, SessionModel, DiagnosisModel, PatientModel, PasswordResetTokenModel):
        table = model.__table__
        if table.name not in existing_tables:
            # Brand-new table: Base.metadata.create_all() already created it
            # with every current column, so there is nothing to migrate.
            continue

        try:
            existing_cols = {c["name"] for c in inspector.get_columns(table.name)}
        except Exception as e:
            logger.error({
                "event": "schema_migration_columns_failed",
                "table": table.name,
                "error": str(e),
            })
            continue

        for column in table.columns:
            if column.name in existing_cols:
                continue

            try:
                col_type = column.type.compile(dialect=engine.dialect)
                default_clause = ""
                if column.default is not None and getattr(column.default, "is_scalar", False):
                    default_value = column.default.arg
                    if isinstance(default_value, str):
                        default_clause = f" DEFAULT '{default_value}'"
                    elif isinstance(default_value, bool):
                        default_clause = f" DEFAULT {str(default_value).upper()}"
                    elif isinstance(default_value, (int, float)):
                        default_clause = f" DEFAULT {default_value}"

                ddl = f"ALTER TABLE {table.name} ADD COLUMN {column.name} {col_type}{default_clause}"
                with engine.begin() as conn:
                    conn.execute(text(ddl))

                SCHEMA_MIGRATIONS_APPLIED.labels(table=table.name, column=column.name).inc()
                logger.info({
                    "event": "schema_migration_applied",
                    "table": table.name,
                    "column": column.name,
                    "ddl": ddl,
                })
            except Exception as e:
                logger.error({
                    "event": "schema_migration_failed",
                    "table": table.name,
                    "column": column.name,
                    "error": str(e),
                })


# -----------------------------------------------------------------
# DB HELPERS
# -----------------------------------------------------------------

def _load_json(value: Optional[str], default: Any) -> Any:
    if value is None:
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def _dump_json(value: Any) -> str:
    return json.dumps(value)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


async def run_db(func, *args, **kwargs):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: func(*args, **kwargs))


# -----------------------------------------------------------------
# ML MODELS + HOT-RELOAD
# -----------------------------------------------------------------

LOADED_MODELS: Dict[str, Any]      = {}
PREVIOUS_MODELS: Dict[str, Any]    = {}
ML_STARTUP_COMPLETE: asyncio.Event = asyncio.Event()


def _load_single_model(fname: str) -> None:
    key  = fname.replace(".pkl", "")
    path = os.path.join(MODELS_DIR, fname)
    try:
        candidate              = joblib.load(path)
        PREVIOUS_MODELS[key]   = LOADED_MODELS.get(key)
        LOADED_MODELS[key]     = candidate
        logger.info({"event": "model_loaded", "file": fname})
    except Exception as e:
        logger.error({"event": "model_load_failed", "file": fname, "error": str(e)})
        if key in PREVIOUS_MODELS and PREVIOUS_MODELS[key] is not None:
            LOADED_MODELS[key] = PREVIOUS_MODELS[key]
            logger.warning({"event": "model_rollback", "key": key})


def load_ml_models() -> None:
    if not JOBLIB_AVAILABLE:
        logger.info({"event": "ml_skip", "reason": "joblib not available"})
        ML_STARTUP_COMPLETE.set()
        return
    os.makedirs(MODELS_DIR, exist_ok=True)
    pkl_files = [f for f in os.listdir(MODELS_DIR) if f.endswith(".pkl")]
    if not pkl_files:
        logger.info({"event": "ml_skip", "reason": "no .pkl files found"})
        ML_STARTUP_COMPLETE.set()
        return
    for fname in pkl_files:
        _load_single_model(fname)
    ML_STARTUP_COMPLETE.set()


class _ModelFileHandler(FileSystemEventHandler):
    def on_modified(self, event):
        if isinstance(event, FileModifiedEvent) and event.src_path.endswith(".pkl"):
            fname = os.path.basename(event.src_path)
            logger.info({"event": "model_change_detected", "file": fname})
            _load_single_model(fname)


_watchdog_observer: Optional[Observer] = None


def start_model_watcher() -> None:
    global _watchdog_observer
    if not JOBLIB_AVAILABLE:
        return
    os.makedirs(MODELS_DIR, exist_ok=True)
    _watchdog_observer = Observer()
    _watchdog_observer.schedule(_ModelFileHandler(), MODELS_DIR, recursive=False)
    _watchdog_observer.start()
    logger.info({"event": "model_watcher_started", "dir": MODELS_DIR})


def stop_model_watcher() -> None:
    if _watchdog_observer:
        _watchdog_observer.stop()
        _watchdog_observer.join()


# -----------------------------------------------------------------
# DISEASE DATA
# -----------------------------------------------------------------

RISK_MAP: Dict[str, str] = {
    "Malaria": "High", "Typhoid": "High", "Dengue": "High", "Chikungunya": "High", "Tuberculosis": "High", "Hepatitis B": "High", "Hepatitis C": "High", "Hepatitis D": "High", "Pneumonia": "High", "Heart attack": "High", "Paralysis (Brain Hemorrhage)": "High", "Hypoglycemia": "High",
    "Hepatitis A": "Medium", "Hepatitis E": "Medium", "Alcoholic Hepatitis": "Medium", "Chronic cholestasis": "Medium", "Jaundice": "Medium", "Chicken Pox": "Medium", "Bronchial Asthma": "Medium", "Urinary Tract Infection": "Medium", "Dimorphic Haemorrhoids": "Medium", "Peptic Ulcer Disease": "Medium", "Diabetes": "Medium", "Hypertension": "Medium", "Gastroenteritis": "Medium", "Hypothyroidism": "Medium", "Hyperthyroidism": "Medium",
    "Fungal Infection": "Low", "Allergy": "Low", "Common Cold": "Low", "Drug Reaction": "Low", "GERD": "Low", "Migraine": "Low", "Cervical spondylosis": "Low", "Varicose veins": "Low", "Osteoarthritis": "Low", "Arthritis": "Low", "Paroxysmal Positional Vertigo": "Low", "Acne": "Low", "Psoriasis": "Low", "Impetigo": "Low",
    "Meningitis": "High",
}


DISEASE_SYMPTOM_MAP: Dict[str, List[str]] = {
    "Malaria": ["high_fever","chills","sweating","headache","muscle_pain","vomiting","nausea","diarrhoea"],
    "Typhoid": ["high_fever","chills","fatigue","vomiting","headache","nausea","constipation","abdominal_pain","diarrhoea","toxic_look_typhos","belly_pain"],
    "Dengue": ["high_fever","headache","pain_behind_the_eyes","loss_of_appetite","back_pain","skin_rash","vomiting","fatigue","chills","joint_pain","malaise","muscle_pain","red_spots_over_body"],
    "Chikungunya": ["skin_rash","joint_pain","fatigue","nausea","redness_of_eyes"],
    "Tuberculosis": ["blood_in_sputum","chest_pain","phlegm","malaise","swelled_lymph_nodes","yellowing_of_eyes","mild_fever","loss_of_appetite","sweating","breathlessness","high_fever","cough","weight_loss","fatigue","vomiting","chills"],
    "Hepatitis B": ["yellowing_of_eyes","malaise","receiving_blood_transfusion","receiving_unsterile_injections","yellowish_skin","lethargy","fatigue","itching","yellow_urine","abdominal_pain","loss_of_appetite","dark_urine"],
    "Hepatitis C": ["fatigue","yellowish_skin","nausea","loss_of_appetite","receiving_blood_transfusion","receiving_unsterile_injections","yellowing_of_eyes"],
    "Hepatitis D": ["joint_pain","vomiting","fatigue","yellowish_skin","dark_urine","nausea","loss_of_appetite","abdominal_pain","yellowing_of_eyes"],
    "Pneumonia": ["chest_pain","rusty_sputum","fast_heart_rate","cough","fatigue","chills","high_fever","malaise","sweating","breathlessness","phlegm"],
    "Heart attack": ["heartburn","chest_pain","vomiting","sweating","breathlessness"],
    "Paralysis (Brain Hemorrhage)": ["altered_sensorium","vomiting","headache","weakness_of_one_body_side"],
    "Hypoglycemia": ["slurred_speech","irritability","palpitations","excessive_hunger","sweating","anxiety","fatigue","vomiting","blurred_and_distorted_vision","nausea","headache","drying_and_tingling_lips"],
    "Hepatitis A": ["mild_fever","muscle_pain","yellowing_of_eyes","yellowish_skin","vomiting","joint_pain","dark_urine","abdominal_pain","loss_of_appetite","nausea","diarrhoea"],
    "Hepatitis E": ["stomach_bleeding","yellowing_of_eyes","coma","loss_of_appetite","abdominal_pain","yellowish_skin","high_fever","fatigue","vomiting","joint_pain","nausea","dark_urine","acute_liver_failure"],
    "Alcoholic Hepatitis": ["vomiting","yellowish_skin","abdominal_pain","fluid_overload","swelling_of_stomach","distention_of_abdomen","history_of_alcohol_consumption"],
    "Chronic cholestasis": ["itching","vomiting","yellowish_skin","nausea","loss_of_appetite","abdominal_pain","yellowing_of_eyes"],
    "Jaundice": ["itching","vomiting","fatigue","weight_loss","high_fever","yellowish_skin","dark_urine","abdominal_pain"],
    "Chicken Pox": ["malaise","red_spots_over_body","itching","fatigue","skin_rash","lethargy","high_fever","loss_of_appetite","headache","swelled_lymph_nodes","mild_fever"],
    "Bronchial Asthma": ["breathlessness","high_fever","family_history","mucoid_sputum","cough","fatigue"],
    "Urinary Tract Infection": ["bladder_discomfort","continuous_feel_of_urine","burning_micturition","foul_smell_of_urine"],
    "Dimorphic Haemorrhoids": ["constipation","pain_during_bowel_movements","pain_in_anal_region","bloody_stool","irritation_in_anus"],
    "Peptic Ulcer Disease": ["vomiting","abdominal_pain","internal_itching","passage_of_gases","indigestion","loss_of_appetite"],
    "Diabetes": ["polyuria","increased_appetite","weight_loss","restlessness","fatigue","excessive_hunger","lethargy","irregular_sugar_level","blurred_and_distorted_vision","obesity","mood_swings","dehydration","urinating_a_lot"],
    "Hypertension": ["lack_of_concentration","loss_of_balance","headache","dizziness","chest_pain"],
    "Gastroenteritis": ["diarrhoea","vomiting","sunken_eyes","dehydration"],
    "Hypothyroidism": ["irritability","swollen_extremeties","depression","enlarged_thyroid","brittle_nails","abnormal_menstruation","weight_gain","cold_hands_and_feets","mood_swings","dizziness","lethargy","puffy_face_and_eyes","fatigue"],
    "Hyperthyroidism": ["muscle_weakness","abnormal_menstruation","irritability","weight_loss","mood_swings","fatigue","restlessness","fast_heart_rate","diarrhoea","sweating","excessive_hunger"],
    "Fungal Infection": ["itching","skin_rash","nodal_skin_eruptions","dischromic_patches"],
    "Allergy": ["continuous_sneezing","shivering","chills","watering_from_eyes"],
    "Common Cold": ["phlegm","muscle_pain","loss_of_smell","chest_pain","congestion","runny_nose","sinus_pressure","redness_of_eyes","throat_irritation","continuous_sneezing","malaise","headache","swelled_lymph_nodes","fatigue","cough","chills","high_fever"],
    "Drug Reaction": ["itching","skin_rash","stomach_pain","burning_micturition","spotting_urination"],
    "GERD": ["stomach_pain","chest_pain","cough","acidity","vomiting","ulcers_on_tongue"],
    "Migraine": ["acidity","indigestion","headache","blurred_and_distorted_vision","excessive_hunger","stiff_neck","depression","irritability","visual_disturbances"],
    "Cervical spondylosis": ["neck_pain","loss_of_balance","dizziness","back_pain","weakness_in_limbs"],
    "Varicose veins": ["fatigue","cramps","bruising","obesity","swollen_legs","prominent_veins_on_calf","swollen_blood_vessels"],
    "Osteoarthritis": ["joint_pain","neck_pain","knee_pain","hip_joint_pain","swelling_joints","painful_walking"],
    "Arthritis": ["muscle_weakness","stiff_neck","swelling_joints","movement_stiffness","painful_walking"],
    "Paroxysmal Positional Vertigo": ["vomiting","headache","nausea","loss_of_balance","unsteadiness","spinning_movements"],
    "Acne": ["skin_rash","pus_filled_pimples","blackheads","scurring"],
    "Psoriasis": ["skin_rash","joint_pain","skin_peeling","silver_like_dusting","small_dents_in_nails","inflammatory_nails"],
    "Impetigo": ["skin_rash","blister","red_sore_around_nose","yellow_crust_ooze","high_fever"],
    "Meningitis": ["high_fever","headache","stiff_neck","vomiting","altered_sensorium","coma"],
}

# -----------------------------------------------------------------
# SYMPTOM SPECIFICITY WEIGHTS
#
# Root cause of the confidence imbalance: a symptom like "fatigue" or
# "headache" appears in well over half of DISEASE_SYMPTOM_MAP, while a
# symptom like "polyuria" or "blurred_and_distorted_vision" appears only
# under Diabetes. Both were previously worth an identical +3 when
# confirmed. That let any disease built mostly from common, overlapping
# symptoms (Common Cold, Tuberculosis, and Dengue all share most of their
# symptoms with several other febrile illnesses) accumulate score from
# confirmations that are only weakly diagnostic,
# while a disease defined by a small set of narrow, specific symptoms
# (Diabetes) could only earn the same +3 per confirmation despite each of
# its symptoms being far more informative on its own. The same flat
# weighting fed get_next_question()'s ranking, so a disease built from
# common symptoms would keep surfacing in the top-6 far more often purely
# from overlap, not from being genuinely well-supported -- crowding out
# the specific follow-up questions a narrower disease like Diabetes needs
# in order to build up a comparable confidence score within the 15-question
# cap.
#
# SYMPTOM_WEIGHT gives each symptom an inverse-frequency weight based on
# how many diseases in DISEASE_SYMPTOM_MAP list it (1.0 for a symptom
# unique to one disease, dropping toward ~0.05-0.15 for symptoms shared
# across a dozen or more). This is applied to confirmed-symptom scoring
# only (see score_disease and _disease_confidence below) -- denied-symptom
# scoring is left untouched, preserving the existing "+3 confirmed / -1
# denied" model used in the adaptive-engine explanation. The effect is
# that confirming a highly distinguishing symptom now counts far more
# toward both question ranking and final confidence than confirming a
# generic one, which is what actually differentiates diseases in practice.
# -----------------------------------------------------------------

_SYMPTOM_DISEASE_COUNT: Dict[str, int] = {}
for _disease_syms in DISEASE_SYMPTOM_MAP.values():
    for _sym in _disease_syms:
        _SYMPTOM_DISEASE_COUNT[_sym] = _SYMPTOM_DISEASE_COUNT.get(_sym, 0) + 1

SYMPTOM_WEIGHT: Dict[str, float] = {
    sym: round(1.0 / count, 4) for sym, count in _SYMPTOM_DISEASE_COUNT.items()
}

# A single disease may not consume more than this many of the 15-question
# budget in get_next_question(), even while it's the top-scoring candidate.
# Without this ceiling, "prefer the current leader" (see get_next_question's
# docstring) can drift back toward the pre-taper bug where one disease --
# typically whichever has the longest symptom list -- absorbs nearly the
# entire session and starves every other candidate of a real differential.
QUESTION_MONOPOLY_CAP = 8

# Once the base BASE_QUESTION_BUDGET questions are used, a session may
# continue asking ONLY a single, clearly-leading disease's own remaining
# symptoms -- see get_confirmation_extension_question() below -- instead of
# hard-stopping even when that leader still has unasked symptoms of its
# own. This exists because longer-symptom-list diseases (e.g. Hepatitis B,
# Common Cold, Tuberculosis) could finish under-covered within the base
# budget and get out-ranked by a shorter-list relative that happened to
# get fully asked, purely because of list length rather than the actual
# evidence. EXTENDED_QUESTION_CEILING is a hard ceiling this extension can
# never cross, so ambiguous sessions (no clear leader) still end promptly
# at BASE_QUESTION_BUDGET exactly as before.
BASE_QUESTION_BUDGET      = 15
EXTENDED_QUESTION_CEILING = 22

# Confirmation-extension thresholds: the leader must have had at least
# this many of its OWN symptoms asked already (so one lucky early "yes"
# can't trigger the extension), and at least this fraction of those asked
# symptoms must have been confirmed "yes".
LEADER_CONFIRM_MIN_ASKED = 3
LEADER_CONFIRM_RATIO     = 2 / 3  # ~66%

ALL_QUESTIONS: List[Dict[str, str]] = [
    {"id":"back_pain","question":"Do you have back pain?","category":"General"},
    {"id":"chills","question":"Do you have chills or shivering?","category":"General"},
    {"id":"dehydration","question":"Do you feel severely dehydrated?","category":"General"},
    {"id":"fatigue","question":"Do you feel unusually tired or weak?","category":"General"},
    {"id":"headache","question":"Do you have headaches?","category":"General"},
    {"id":"high_fever","question":"Do you have a high fever?","category":"General"},
    {"id":"joint_pain","question":"Do you have joint pain?","category":"General"},
    {"id":"lethargy","question":"Do you feel a lack of energy or sluggishness?","category":"General"},
    {"id":"malaise","question":"Do you feel generally unwell or sick?","category":"General"},
    {"id":"mild_fever","question":"Do you have a mild fever?","category":"General"},
    {"id":"muscle_pain","question":"Do you have muscle pain or body aches?","category":"General"},
    {"id":"shivering","question":"Are you shivering?","category":"General"},
    {"id":"sweating","question":"Do you have episodes of sweating?","category":"General"},
    {"id":"blood_in_sputum","question":"Are you coughing up blood?","category":"Respiratory"},
    {"id":"breathlessness","question":"Do you have difficulty breathing or shortness of breath?","category":"Respiratory"},
    {"id":"chest_pain","question":"Do you have chest pain?","category":"Respiratory"},
    {"id":"congestion","question":"Do you have nasal or chest congestion?","category":"Respiratory"},
    {"id":"continuous_sneezing","question":"Do you sneeze frequently?","category":"Respiratory"},
    {"id":"cough","question":"Do you have a cough?","category":"Respiratory"},
    {"id":"loss_of_smell","question":"Have you lost your sense of smell?","category":"Respiratory"},
    {"id":"mucoid_sputum","question":"Are you coughing up thick, mucus-like sputum?","category":"Respiratory"},
    {"id":"phlegm","question":"Are you coughing up phlegm or mucus?","category":"Respiratory"},
    {"id":"runny_nose","question":"Do you have a runny nose?","category":"Respiratory"},
    {"id":"rusty_sputum","question":"Are you coughing up rusty or brown-coloured sputum?","category":"Respiratory"},
    {"id":"sinus_pressure","question":"Do you have sinus pressure or nasal congestion?","category":"Respiratory"},
    {"id":"throat_irritation","question":"Do you have a sore or irritated throat?","category":"Respiratory"},
    {"id":"watering_from_eyes","question":"Do you have watery eyes?","category":"Respiratory"},
    {"id":"abdominal_pain","question":"Do you have abdominal or belly pain?","category":"Digestive"},
    {"id":"acidity","question":"Do you have acidity or a burning sensation in your stomach?","category":"Digestive"},
    {"id":"belly_pain","question":"Do you have persistent belly pain?","category":"Digestive"},
    {"id":"bloody_stool","question":"Do you notice blood in your stool?","category":"Digestive"},
    {"id":"constipation","question":"Do you have constipation?","category":"Digestive"},
    {"id":"diarrhoea","question":"Do you have diarrhoea?","category":"Digestive"},
    {"id":"distention_of_abdomen","question":"Do you feel bloated or have a distended abdomen?","category":"Digestive"},
    {"id":"heartburn","question":"Do you have heartburn?","category":"Digestive"},
    {"id":"indigestion","question":"Do you have indigestion?","category":"Digestive"},
    {"id":"loss_of_appetite","question":"Have you lost your appetite?","category":"Digestive"},
    {"id":"nausea","question":"Do you feel nauseous?","category":"Digestive"},
    {"id":"passage_of_gases","question":"Do you have excessive gas?","category":"Digestive"},
    {"id":"stomach_bleeding","question":"Do you have stomach bleeding?","category":"Digestive"},
    {"id":"stomach_pain","question":"Do you have stomach pain?","category":"Digestive"},
    {"id":"sunken_eyes","question":"Do your eyes look sunken?","category":"Digestive"},
    {"id":"swelling_of_stomach","question":"Is your stomach area swollen?","category":"Digestive"},
    {"id":"ulcers_on_tongue","question":"Do you have ulcers on your tongue?","category":"Digestive"},
    {"id":"vomiting","question":"Have you been vomiting?","category":"Digestive"},
    {"id":"acute_liver_failure","question":"Do you have confusion, severe swelling, or very dark urine along with yellowing of your skin or eyes?","category":"Liver"},
    {"id":"dark_urine","question":"Is your urine dark or tea-coloured?","category":"Liver"},
    {"id":"fluid_overload","question":"Do you have abnormal body swelling or fluid retention?","category":"Liver"},
    {"id":"internal_itching","question":"Do you experience internal itching?","category":"Liver"},
    {"id":"yellow_urine","question":"Is your urine unusually yellow?","category":"Liver"},
    {"id":"yellowing_of_eyes","question":"Are the whites of your eyes turning yellow?","category":"Liver"},
    {"id":"yellowish_skin","question":"Is your skin yellowish or jaundiced?","category":"Liver"},
    {"id":"blackheads","question":"Do you have blackheads?","category":"Skin"},
    {"id":"blister","question":"Do you have fluid-filled blisters?","category":"Skin"},
    {"id":"bruising","question":"Do you bruise easily?","category":"Skin"},
    {"id":"dischromic_patches","question":"Do you have discoloured patches on your skin?","category":"Skin"},
    {"id":"itching","question":"Do you have itchy skin?","category":"Skin"},
    {"id":"nodal_skin_eruptions","question":"Do you have nodules or skin eruptions?","category":"Skin"},
    {"id":"pus_filled_pimples","question":"Do you have pus-filled pimples?","category":"Skin"},
    {"id":"red_sore_around_nose","question":"Do you have red sores around your nose or mouth?","category":"Skin"},
    {"id":"red_spots_over_body","question":"Do you have red spots on your body?","category":"Skin"},
    {"id":"scurring","question":"Do you have scarring on your skin?","category":"Skin"},
    {"id":"silver_like_dusting","question":"Do you have silvery, scale-like patches on your skin?","category":"Skin"},
    {"id":"skin_peeling","question":"Is your skin peeling?","category":"Skin"},
    {"id":"skin_rash","question":"Do you have a skin rash?","category":"Skin"},
    {"id":"yellow_crust_ooze","question":"Do your skin sores ooze a yellow crust?","category":"Skin"},
    {"id":"blurred_and_distorted_vision","question":"Do you have blurred or distorted vision?","category":"Eyes"},
    {"id":"pain_behind_the_eyes","question":"Do you have pain behind your eyes?","category":"Eyes"},
    {"id":"puffy_face_and_eyes","question":"Do you have puffiness around your face or eyes?","category":"Eyes"},
    {"id":"redness_of_eyes","question":"Do you have red or irritated eyes?","category":"Eyes"},
    {"id":"visual_disturbances","question":"Do you have visual disturbances, such as flashing lights or blind spots?","category":"Eyes"},
    {"id":"abnormal_menstruation","question":"Have you noticed abnormal or irregular menstrual periods?","category":"Urinary"},
    {"id":"bladder_discomfort","question":"Do you have bladder discomfort?","category":"Urinary"},
    {"id":"burning_micturition","question":"Do you feel a burning sensation when urinating?","category":"Urinary"},
    {"id":"continuous_feel_of_urine","question":"Do you feel like you need to urinate again right after you've just gone?","category":"Urinary"},
    {"id":"foul_smell_of_urine","question":"Does your urine have an unusual smell?","category":"Urinary"},
    {"id":"polyuria","question":"When you do urinate, are you passing much larger amounts than usual each time?","category":"Urinary"},
    {"id":"spotting_urination","question":"Do you notice spotting during urination?","category":"Urinary"},
    {"id":"urinating_a_lot","question":"Are you making more trips to the bathroom to urinate than usual?","category":"Urinary"},
    {"id":"irritation_in_anus","question":"Do you have irritation around the anus?","category":"Rectal"},
    {"id":"pain_during_bowel_movements","question":"Do you have pain during bowel movements?","category":"Rectal"},
    {"id":"pain_in_anal_region","question":"Do you have pain in your anal region?","category":"Rectal"},
    {"id":"altered_sensorium","question":"Do you feel confused or disoriented?","category":"Neurological"},
    {"id":"anxiety","question":"Have you been feeling anxious?","category":"Neurological"},
    {"id":"coma","question":"Have you experienced any loss of consciousness?","category":"Neurological"},
    {"id":"depression","question":"Have you been feeling persistently low or depressed?","category":"Neurological"},
    {"id":"dizziness","question":"Do you feel dizzy?","category":"Neurological"},
    {"id":"irritability","question":"Have you been feeling unusually irritable?","category":"Neurological"},
    {"id":"lack_of_concentration","question":"Do you have trouble concentrating?","category":"Neurological"},
    {"id":"loss_of_balance","question":"Do you have trouble keeping your balance?","category":"Neurological"},
    {"id":"mood_swings","question":"Have you been experiencing mood swings?","category":"Neurological"},
    {"id":"muscle_weakness","question":"Do you have general muscle weakness?","category":"Neurological"},
    {"id":"restlessness","question":"Do you feel restless or agitated?","category":"Neurological"},
    {"id":"slurred_speech","question":"Have you had episodes of slurred speech?","category":"Neurological"},
    {"id":"spinning_movements","question":"Do you feel a spinning sensation (vertigo)?","category":"Neurological"},
    {"id":"toxic_look_typhos","question":"Do you look or feel severely, acutely ill?","category":"Neurological"},
    {"id":"unsteadiness","question":"Do you feel unsteady on your feet?","category":"Neurological"},
    {"id":"weakness_in_limbs","question":"Do you have weakness in your arms or legs?","category":"Neurological"},
    {"id":"weakness_of_one_body_side","question":"Do you have sudden weakness on one side of your body?","category":"Neurological"},
    {"id":"brittle_nails","question":"Do you have brittle nails?","category":"Metabolic"},
    {"id":"cold_hands_and_feets","question":"Do your hands and feet often feel unusually cold?","category":"Metabolic"},
    {"id":"drying_and_tingling_lips","question":"Do you have dry or tingling lips?","category":"Metabolic"},
    {"id":"enlarged_thyroid","question":"Have you noticed swelling in the front of your neck (thyroid area)?","category":"Metabolic"},
    {"id":"excessive_hunger","question":"Are you excessively hungry?","category":"Metabolic"},
    {"id":"increased_appetite","question":"Has your appetite increased significantly?","category":"Metabolic"},
    {"id":"irregular_sugar_level","question":"Do you have an irregular blood sugar level?","category":"Metabolic"},
    {"id":"obesity","question":"Are you significantly overweight?","category":"Metabolic"},
    {"id":"palpitations","question":"Do you have a racing or pounding heartbeat?","category":"Metabolic"},
    {"id":"swollen_extremeties","question":"Do you have swelling in your arms or legs?","category":"Metabolic"},
    {"id":"weight_gain","question":"Have you experienced unexplained weight gain?","category":"Metabolic"},
    {"id":"weight_loss","question":"Have you experienced unexplained weight loss?","category":"Metabolic"},
    {"id":"cramps","question":"Do you get muscle cramps?","category":"Cardiovascular"},
    {"id":"fast_heart_rate","question":"Do you have a fast or irregular heartbeat?","category":"Cardiovascular"},
    {"id":"prominent_veins_on_calf","question":"Do you have prominent, visible veins on your calves?","category":"Cardiovascular"},
    {"id":"swollen_blood_vessels","question":"Do you have visibly swollen or bulging blood vessels?","category":"Cardiovascular"},
    {"id":"swollen_legs","question":"Do you have swollen legs?","category":"Cardiovascular"},
    {"id":"hip_joint_pain","question":"Do you have hip joint pain?","category":"Musculoskeletal"},
    {"id":"inflammatory_nails","question":"Are your nails inflamed or discoloured?","category":"Musculoskeletal"},
    {"id":"knee_pain","question":"Do you have knee pain?","category":"Musculoskeletal"},
    {"id":"movement_stiffness","question":"Do you feel stiffness when moving?","category":"Musculoskeletal"},
    {"id":"neck_pain","question":"Do you have neck pain?","category":"Musculoskeletal"},
    {"id":"painful_walking","question":"Is walking painful for you?","category":"Musculoskeletal"},
    {"id":"small_dents_in_nails","question":"Do you have small dents or pits in your nails?","category":"Musculoskeletal"},
    {"id":"stiff_neck","question":"Do you have a stiff neck?","category":"Musculoskeletal"},
    {"id":"swelling_joints","question":"Do you have swelling in your joints?","category":"Musculoskeletal"},
    {"id":"swelled_lymph_nodes","question":"Do you have swollen lymph nodes?","category":"Infection"},
    {"id":"family_history","question":"Does anyone in your close family have asthma?","category":"History"},
    {"id":"history_of_alcohol_consumption","question":"Do you have a history of heavy alcohol use?","category":"History"},
    {"id":"receiving_blood_transfusion","question":"Have you received a blood transfusion recently?","category":"History"},
    {"id":"receiving_unsterile_injections","question":"Have you been injected with unsterile equipment?","category":"History"},
]

Q_INDEX: Dict[str, Dict] = {q["id"]: q for q in ALL_QUESTIONS}

DEFAULT_RECS: Dict[str, Dict[str, str]] = {
    "Malaria": {"home_care":"Rest and drink plenty of fluids","test":"Malaria RDT or blood smear","doctor":"Go to clinic immediately for antimalarial treatment","safety":"Do not delay - malaria can become severe quickly"},
    "Typhoid": {"home_care":"Rest, eat soft foods, drink clean water only","test":"Widal test or blood culture","doctor":"See a doctor for antibiotic prescription","safety":"Avoid spreading infection - wash hands frequently"},
    "Dengue": {"home_care":"Rest and drink fluids - avoid aspirin or ibuprofen","test":"Dengue NS1 antigen test","doctor":"Seek care immediately if you notice bleeding or severe pain","safety":"Aspirin can worsen bleeding in dengue"},
    "Chikungunya": {"home_care":"Rest, drink fluids, and elevate painful joints","test":"Chikungunya IgM antibody test","doctor":"See a doctor if joint pain is severe or persists beyond a week","safety":"Avoid mosquito bites during illness to prevent further spread"},
    "Tuberculosis": {"home_care":"Rest, isolate yourself, keep room well-ventilated","test":"Chest X-ray and sputum test","doctor":"Visit a TB clinic immediately","safety":"TB is contagious - wear a mask and avoid crowded places"},
    "Hepatitis B": {"home_care":"Rest and avoid alcohol completely","test":"Hepatitis B surface antigen (HBsAg) test","doctor":"See a doctor for antiviral medication evaluation","safety":"Hepatitis B is contagious - avoid sharing needles or razors"},
    "Hepatitis C": {"home_care":"Rest and avoid alcohol","test":"Hepatitis C antibody test","doctor":"See a specialist for antiviral treatment","safety":"Avoid sharing sharp objects with others"},
    "Hepatitis D": {"home_care":"Rest and stop alcohol completely","test":"Hepatitis D antibody and liver function tests","doctor":"Seek specialist care urgently","safety":"Hepatitis D only occurs with hepatitis B - urgent care needed"},
    "Pneumonia": {"home_care":"Rest, keep warm, drink warm fluids","test":"Chest X-ray","doctor":"Visit clinic immediately for antibiotic treatment","safety":"Pneumonia can worsen quickly - do not wait"},
    "Heart attack": {"home_care":"Stop all activity and stay calm while awaiting help","test":"ECG and cardiac enzyme (troponin) tests","doctor":"Call emergency services or go to the nearest hospital immediately","safety":"This is a medical emergency - do not attempt to drive yourself"},
    "Paralysis (Brain Hemorrhage)": {"home_care":"Keep the person still and lying on their side if unconscious","test":"CT scan or MRI of the brain","doctor":"Call emergency services immediately","safety":"This is a medical emergency - every minute of delay matters"},
    "Hypoglycemia": {"home_care":"Consume a fast-acting sugar source immediately (juice, sugar, glucose tablets)","test":"Blood glucose measurement","doctor":"See a doctor if episodes recur or you have diabetes medication","safety":"Severe or prolonged low blood sugar can cause loss of consciousness - seek emergency care if symptoms don't improve within 15 minutes"},
    "Hepatitis A": {"home_care":"Rest and drink clean water - eat lightly","test":"Hepatitis A IgM antibody test","doctor":"See a doctor if symptoms worsen","safety":"Avoid sharing food or drinks with others"},
    "Hepatitis E": {"home_care":"Rest and drink clean water only","test":"Hepatitis E IgM antibody test","doctor":"See a doctor - especially important if pregnant","safety":"Very dangerous during pregnancy - seek care urgently if pregnant"},
    "Alcoholic Hepatitis": {"home_care":"Stop alcohol completely and eat well","test":"Liver function tests (LFTs)","doctor":"Seek medical care urgently","safety":"Continued alcohol use can be fatal with this condition"},
    "Chronic cholestasis": {"home_care":"Avoid alcohol and fatty foods, stay hydrated","test":"Liver function tests and abdominal ultrasound","doctor":"See a doctor to identify and treat the underlying cause","safety":"Persistent itching and jaundice should not be ignored"},
    "Jaundice": {"home_care":"Rest and drink clean water","test":"Liver function tests and bilirubin level","doctor":"See a doctor to find the underlying cause","safety":"Jaundice is a sign of another condition - do not ignore it"},
    "Chicken Pox": {"home_care":"Rest, avoid scratching, apply calamine lotion","test":"No test usually needed","doctor":"See a doctor if blisters become infected or fever is very high","safety":"Highly contagious - stay home and avoid contact with others"},
    "Bronchial Asthma": {"home_care":"Avoid triggers and use your prescribed inhaler","test":"Peak flow measurement or spirometry","doctor":"See a doctor for long-term management plan","safety":"Carry your inhaler at all times"},
    "Urinary Tract Infection": {"home_care":"Drink plenty of water and avoid spicy food","test":"Urine culture and sensitivity test","doctor":"See a doctor for antibiotic prescription","safety":"Do not hold urine - empty your bladder regularly"},
    "Dimorphic Haemorrhoids": {"home_care":"Eat high-fibre foods and avoid straining on the toilet","test":"No test usually needed","doctor":"See a doctor if bleeding continues or worsens","safety":"Avoid sitting for long periods"},
    "Peptic Ulcer Disease": {"home_care":"Avoid spicy food, alcohol and pain tablets like aspirin","test":"H. pylori breath test or endoscopy if needed","doctor":"See a doctor for antacid or antibiotic treatment","safety":"Avoid aspirin and ibuprofen - they worsen ulcers"},
    "Diabetes": {"home_care":"Reduce sugar and refined carbohydrates in your diet","test":"Fasting blood glucose and HbA1c test","doctor":"See a doctor for a diabetes management plan","safety":"Monitor your blood sugar regularly if you have a glucometer"},
    "Hypertension": {"home_care":"Reduce salt intake and manage stress","test":"Blood pressure measurement over multiple readings","doctor":"See a doctor for a blood pressure management plan","safety":"Seek emergency care for severe headache, chest pain, or vision changes"},
    "Gastroenteritis": {"home_care":"Drink oral rehydration solution and eat bland foods","test":"Stool test if symptoms persist beyond a few days","doctor":"See a doctor if you cannot keep fluids down or symptoms worsen","safety":"Dehydration can become serious quickly in young children and the elderly"},
    "Hypothyroidism": {"home_care":"Maintain a balanced diet and regular sleep schedule","test":"Thyroid function test (TSH, T3, T4)","doctor":"See a doctor for thyroid hormone replacement evaluation","safety":"Untreated hypothyroidism can affect heart and metabolic health long-term"},
    "Hyperthyroidism": {"home_care":"Avoid caffeine and get adequate rest","test":"Thyroid function test (TSH, T3, T4)","doctor":"See a doctor or endocrinologist for management options","safety":"Seek prompt care for a rapid heartbeat or significant weight loss"},
    "Fungal Infection": {"home_care":"Keep the affected area dry and clean","test":"No test usually needed","doctor":"Visit a pharmacy for antifungal cream","safety":"Avoid sharing personal items like socks or towels"},
    "Allergy": {"home_care":"Avoid known triggers and stay indoors during high pollen periods","test":"Allergy skin prick test if symptoms are recurrent","doctor":"See a doctor for antihistamine prescription","safety":"If you have throat swelling or difficulty breathing - go to emergency immediately"},
    "Common Cold": {"home_care":"Rest and drink warm fluids","test":"No test needed","doctor":"Visit clinic if symptoms persist beyond 7 days","safety":"Wash hands frequently to avoid spreading"},
    "Drug Reaction": {"home_care":"Stop the suspected medication immediately","test":"No test usually needed","doctor":"See a doctor immediately if rash spreads or breathing is affected","safety":"Seek emergency care if you have throat swelling or difficulty breathing"},
    "GERD": {"home_care":"Avoid large meals, spicy food, and lying down right after eating","test":"No test usually needed for mild cases; endoscopy if severe or persistent","doctor":"See a doctor if symptoms occur more than twice a week","safety":"Persistent heartburn with weight loss or difficulty swallowing needs prompt evaluation"},
    "Migraine": {"home_care":"Rest in a quiet, dark room and stay hydrated","test":"No test usually needed unless symptoms are atypical","doctor":"See a doctor if migraines are frequent or severe","safety":"Seek urgent care for the worst headache of your life or headache with fever and stiff neck"},
    "Cervical spondylosis": {"home_care":"Maintain good posture and do gentle neck stretches","test":"Neck X-ray or MRI if symptoms are severe","doctor":"See a doctor or physiotherapist for a management plan","safety":"Seek care promptly if you develop arm weakness or numbness"},
    "Varicose veins": {"home_care":"Elevate your legs and avoid standing for long periods","test":"Doppler ultrasound of the legs","doctor":"See a doctor if veins become painful or skin changes occur","safety":"Watch for signs of a blood clot such as sudden leg swelling or pain"},
    "Osteoarthritis": {"home_care":"Maintain a healthy weight and stay gently active","test":"Joint X-ray if needed","doctor":"See a doctor for a pain management plan","safety":"Avoid high-impact activities that worsen joint pain"},
    "Arthritis": {"home_care":"Apply warm or cold compresses and stay gently active","test":"Blood tests and joint imaging if needed","doctor":"See a doctor or rheumatologist for evaluation","safety":"Persistent joint swelling with fever should be evaluated promptly"},
    "Paroxysmal Positional Vertigo": {"home_care":"Move slowly when changing position and avoid sudden head movements","test":"No test usually needed; a positional test may be done by a doctor","doctor":"See a doctor if episodes are frequent or affect daily activities","safety":"Avoid driving or climbing during an active episode of vertigo"},
    "Acne": {"home_care":"Keep skin clean and avoid picking at pimples","test":"No test usually needed","doctor":"See a dermatologist if over-the-counter treatment doesn't help","safety":"Avoid harsh scrubbing, which can worsen inflammation"},
    "Psoriasis": {"home_care":"Moisturise regularly and avoid known triggers such as stress","test":"Usually diagnosed by physical examination; skin biopsy if unclear","doctor":"See a dermatologist for a treatment plan","safety":"Avoid scratching affected areas to prevent infection"},
    "Impetigo": {"home_care":"Keep the affected area clean and covered","test":"No test usually needed","doctor":"See a doctor for antibiotic treatment","safety":"Highly contagious - avoid close contact and sharing towels until treated"},
    "Meningitis": {"home_care":"Do not attempt to treat this at home","test":"Diagnosis typically requires a lumbar puncture (spinal tap) along with blood tests","doctor":"Go to the nearest hospital emergency department immediately","safety":"Meningitis can become life-threatening within hours - do not wait to see if symptoms improve"},
}

# -----------------------------------------------------------------
# CIRCUIT BREAKER
# -----------------------------------------------------------------

class _CBListener(pybreaker.CircuitBreakerListener):
    def state_change(self, cb, old_state, new_state):
        is_open = 1 if str(new_state) == "open" else 0
        CB_STATE.set(is_open)
        logger.warning({"event": "circuit_breaker_state_change", "from": str(old_state), "to": str(new_state)})


_openrouter_cb = pybreaker.CircuitBreaker(
    fail_max=3,
    reset_timeout=60,
    listeners=[_CBListener()],
)

# -----------------------------------------------------------------
# ADAPTIVE ENGINE
# -----------------------------------------------------------------

def score_disease(disease: str, answers: dict) -> float:
    score = 0.0
    for symptom in DISEASE_SYMPTOM_MAP.get(disease, []):
        if answers.get(symptom) is True:
            score += 3.0 * SYMPTOM_WEIGHT.get(symptom, 1.0)
        elif answers.get(symptom) is False:
            score -= 1.0
    return score


def get_next_question(answers: dict, asked: list) -> Optional[dict]:
    """
    Root cause of the original bug ("one disease dominates, everything
    else gets low confidence"): this previously drained the #1-ranked
    disease's ENTIRE unasked symptom list before ever asking about the #2
    candidate. Whichever disease has the longest symptom list and overlaps
    heavily with nearby febrile illnesses (fever, headache, fatigue,
    malaise, vomiting...) tends to reach the #1 slot from almost any early
    "yes" answer, regardless of the person's actual condition. It then
    absorbed most or all of the fixed 15-question budget for itself,
    leaving every other candidate with only 1-4 of their own symptoms ever
    asked. A disease that is 90%+ unasked looks like "no evidence" to both
    the scoring fallback and the trained ML model, so those diseases were
    structurally locked into low confidence almost regardless of the
    person's real answers -- while the disease riding on shared symptoms
    consistently ended up with a near-complete feature profile and a
    comparatively strong score even when it wasn't the actual condition.

    A pure fair-share round robin across all 6 candidates for the whole
    session was tried and rejected: it spread the 15-question budget so
    thin across shifting candidates that even the TRUE underlying disease
    could only ever get 2-4 of its own symptoms confirmed, capping
    everyone's confidence low instead of just the dominant candidate's
    rivals.

    That round-robin fix (sorting the pool by asked_count ascending, i.e.
    "whichever candidate has been touched least goes next") swung the bug
    the other way: the INSTANT a leading candidate had even one question
    asked, it was no longer the least-touched member of the pool, so the
    engine abandoned it for a completely fresh, untouched disease -- even
    when the leader's score was clearly highest. Diseases with longer
    symptom lists need MORE of their own follow-up questions than a
    shorter-list disease to reach comparable coverage, but the tie-break
    rule handed them FEWER, since they got deprioritized after their very
    first question. On a genuinely ambiguous early presentation shared by
    two overlapping diseases, this reliably let the shorter-list disease
    overtake the true leader in the final confidence ranking even when the
    underlying evidence favoured the leader equally or more, simply
    because the shorter list reached a usable coverage ratio faster within
    the same 15-question budget.

    Fix: keep the taper (broad pool early, narrowing later) but make
    CURRENT SCORE the primary sort key within the active pool, so a
    genuine leader keeps getting its own follow-up questions instead of
    being dropped the moment it's touched once. asked_count is then a
    tie-breaker for candidates still tied on score, which preserves the
    original broad-screening behaviour for the early "everyone's at zero"
    phase. QUESTION_MONOPOLY_CAP puts a ceiling back under this -- once a
    disease has consumed its share of the budget, it steps aside for the
    next-best candidate even if it's still scoring highest, so no single
    disease (long symptom list or not) can crowd out the differential
    entirely the way the pre-taper bug did.

    Pool width is a FRACTION of the active disease list (the original
    22-disease design's 6/22, 3/22, 2/22 ratios), not a fixed headcount,
    so behaviour scales automatically if the disease list ever grows or
    shrinks again instead of silently starving the tail the way a fixed
    pool_size=6 did once this engine grew past 22 diseases.
      - First 6 questions:  broad differential (~27% of diseases)
      - Next 5 questions:   narrowing (~14% of diseases)
      - Remaining questions: deep confirmation (~9% of diseases)

    Remaining gap this closes: when several candidates are still fully
    tied (identical score AND identical asked_count -- normally the
    untouched, zero-scored bulk at the start of a session, or after a
    batch of denials), the previous version broke the tie by picking
    whichever candidate happened to sit first in DISEASE_SYMPTOM_MAP's
    definition order and asking ITS next symptom. That's an arbitrary,
    non-clinical tie-break: a disease's reachability within the fixed
    question budget ended up depending on where it happened to be
    inserted into a Python dict, not on how distinctive its symptoms are.
    With a large disease list this could let a disease slip through an
    entire session with zero questions ever probing it -- it might still
    end up ranked #1 by elimination (nothing else outscored it), but with
    0% confidence, since confidence is computed only from symptoms
    actually asked.

    This version breaks a genuine tie by asking about whichever unasked
    symptom is shared by the MOST currently-tied candidates, instead of
    the first tied candidate's own list. That single question then
    confirms or eliminates the largest possible slice of the tied group
    at once, so the tied group shrinks as fast as the data allows and
    reachability for any one disease depends on how distinctive its
    symptoms are, not on dictionary insertion order. When only one
    candidate remains at the top (a genuine score leader), the original
    behaviour is unchanged: its own next unasked symptom is asked directly.
    """
    scores = {d: score_disease(d, answers) for d in DISEASE_SYMPTOM_MAP}
    ranked = sorted(DISEASE_SYMPTOM_MAP.keys(), key=lambda d: scores[d], reverse=True)

    n_diseases = len(DISEASE_SYMPTOM_MAP)
    n_asked = len(asked)
    if n_asked < 6:
        pool_size = max(6, round(n_diseases * 6 / 22))
    elif n_asked < 11:
        pool_size = max(3, round(n_diseases * 3 / 22))
    else:
        pool_size = max(2, round(n_diseases * 2 / 22))
    top = ranked[:pool_size]

    def asked_count(d: str) -> int:
        return sum(1 for s in DISEASE_SYMPTOM_MAP[d] if s in asked)

    def has_unasked(d: str) -> bool:
        return any(s not in asked for s in DISEASE_SYMPTOM_MAP[d])

    # Candidates still under the monopoly cap get first refusal; only
    # fall back to capped-but-unasked candidates if every pool member has
    # already hit the cap (keeps the interview moving instead of stalling).
    under_cap  = [d for d in top if has_unasked(d) and asked_count(d) < QUESTION_MONOPOLY_CAP]
    candidates = under_cap if under_cap else [d for d in top if has_unasked(d)]

    if candidates:
        candidates.sort(key=lambda d: (-scores[d], asked_count(d)))
        best_score, best_asked = scores[candidates[0]], asked_count(candidates[0])
        tied = [d for d in candidates if scores[d] == best_score and asked_count(d) == best_asked]

        if len(tied) == 1:
            chosen_disease = tied[0]
            for sym in DISEASE_SYMPTOM_MAP[chosen_disease]:
                if sym not in asked:
                    q = Q_INDEX.get(sym)
                    if q:
                        return q
        else:
            # Genuine tie: ask about the unasked symptom shared by the
            # most tied candidates (maximum information gain), breaking
            # any further tie by earliest position in ALL_QUESTIONS for a
            # deterministic, repeatable question order.
            coverage: Dict[str, int] = {}
            for d in tied:
                for sym in DISEASE_SYMPTOM_MAP[d]:
                    if sym not in asked:
                        coverage[sym] = coverage.get(sym, 0) + 1
            if coverage:
                question_order = {q["id"]: i for i, q in enumerate(ALL_QUESTIONS)}
                best_symptom = max(coverage, key=lambda s: (coverage[s], -question_order.get(s, 0)))
                q = Q_INDEX.get(best_symptom)
                if q:
                    return q

    for q in ALL_QUESTIONS:
        if q["id"] not in asked:
            return q
    return None


def get_confirmation_extension_question(answers: dict, asked: list) -> Optional[dict]:
    """
    Called only once the base BASE_QUESTION_BUDGET (15) questions have been
    used. Decides whether a single, non-tied leading disease has earned a
    short confirmation extension to finish its OWN profile, and if so
    returns its next unasked symptom directly -- bypassing get_next_question's
    pool/taper/monopoly-cap logic entirely, since the differential-building
    phase is over and the only goal left is completing the leader's own
    symptom coverage. The caller is responsible for enforcing the hard
    EXTENDED_QUESTION_CEILING; this function only decides WHICH question (if
    any) comes next.

    Extension fires only when ALL of the following hold:
      - There's a single top-scoring disease with no other disease tied
        with it on score (a genuine, unambiguous leader) -- ties mean the
        differential is still open, so the session should not have moved
        into single-disease confirmation mode.
      - At least LEADER_CONFIRM_MIN_ASKED of the leader's OWN symptoms have
        already been asked, so a single lucky early "yes" can't trigger
        this on its own.
      - At least LEADER_CONFIRM_RATIO (~66%) of those asked symptoms were
        answered "yes".
      - The leader still has at least one of its own symptoms left unasked
        (otherwise there's nothing left to confirm).

    Returns None whenever any of the above fails, which ends the session at
    whatever question count it's currently at -- identical to the pre-
    extension behaviour for every session where no clear leader emerges.
    """
    scores = {d: score_disease(d, answers) for d in DISEASE_SYMPTOM_MAP}
    ranked = sorted(DISEASE_SYMPTOM_MAP.keys(), key=lambda d: scores[d], reverse=True)
    if not ranked:
        return None

    leader = ranked[0]
    if len(ranked) > 1 and scores[ranked[1]] == scores[leader]:
        return None  # tied leaders -- no single clear winner to confirm

    leader_symptoms = DISEASE_SYMPTOM_MAP[leader]
    leader_asked = [s for s in leader_symptoms if s in asked]
    if len(leader_asked) < LEADER_CONFIRM_MIN_ASKED:
        return None

    yes_count = sum(1 for s in leader_asked if answers.get(s) is True)
    if yes_count < len(leader_asked) * LEADER_CONFIRM_RATIO - 1e-9:
        return None

    for sym in leader_symptoms:
        if sym not in asked:
            return Q_INDEX.get(sym)

    return None  # leader's own symptom list is already fully asked


def _disease_confidence(disease: str, answers: dict, asked: Optional[list] = None) -> float:
    """
    Confidence for a disease from confirmed vs. denied symptoms, used by the
    non-ML scoring fallback and by the trajectory snapshot.

    Previously this divided confirmed symptoms by the FULL symptom list
    length for the disease (yes_count / len(symptoms)). That structurally
    under-scored diseases with long symptom lists (e.g. a disease with 16
    tracked symptoms confirming 6 strong ones only scored 6/16 = 0.375)
    while ignoring which symptoms had actually been asked. This version
    normalises against symptoms that were actually asked (when supplied)
    and blends the positive-match ratio with a coverage term, so a strong
    partial match on a long-list disease is no longer scored lower than a
    weaker match on a short one.

    The match ratio is further weighted by SYMPTOM_WEIGHT (see definition
    above). Without this, a disease built mostly from generic, widely
    shared symptoms (fatigue, headache, fever) scored identically to one
    built from narrow, highly specific symptoms (polyuria, drying_and_tingling_lips)
    for the same yes/no split -- which is what let common-symptom diseases
    end up with an inflated confidence relative to narrower ones like
    Diabetes even when the actual evidence was weaker. Confirming a
    specific symptom now moves the ratio more than confirming a generic
    one, and denying a specific symptom counts more heavily against it too,
    since both are weighted in the same denominator.
    """
    symptoms = DISEASE_SYMPTOM_MAP.get(disease, [])
    if not symptoms:
        return 0.0

    relevant = [s for s in symptoms if s in asked] if asked else [s for s in symptoms if s in answers]
    if not relevant:
        return 0.0

    weight_total = sum(SYMPTOM_WEIGHT.get(s, 1.0) for s in relevant)
    if weight_total <= 0:
        return 0.0

    matched_weight = sum(
        SYMPTOM_WEIGHT.get(s, 1.0) for s in relevant if answers.get(s) is True
    )
    if matched_weight == 0:
        return 0.0

    match_ratio = matched_weight / weight_total
    coverage    = min(len(relevant) / len(symptoms), 1.0)

    # Coverage previously used a 0.65 floor ("0.65 + 0.35*coverage"), so a
    # disease that had barely been probed -- say two generic symptoms like
    # fatigue and high_fever, both confirmed, out of a 14-symptom list --
    # could still show ~70% confidence purely because match_ratio was 1.0
    # on that tiny, low-coverage sample. That is exactly how a disease like
    # Malaria (many symptoms, most shared broadly) could end up looking
    # artificially well-supported from incidental overlap, while a disease
    # actually built from strong, specific evidence but modest coverage
    # scored no higher. The factor below scales from a low floor at near-
    # zero coverage up toward 1.0 as more of the disease's own symptom list
    # is actually covered, so confidence tracks how much real evidence was
    # gathered, not just the ratio within whatever small sample happened to
    # be asked.
    coverage_factor = min(1.0, 0.25 + 0.75 * coverage)
    confidence = match_ratio * coverage_factor
    return round(min(0.95, max(0.10, confidence)), 4)


def compute_score_snapshot(answers: dict, asked: Optional[list] = None) -> Dict[str, float]:
    """
    Powers the "Confidence Evolution" trajectory shown during the
    interview (one snapshot recorded after every answered question).

    This used to branch on whether the ML ensemble was loaded: if so, it
    returned the ensemble's raw, uncalibrated predict_proba() values; if
    not, it fell back to _disease_confidence(). That meant the trajectory
    graph the person watches DURING the interview and the final result
    screen at the END of it could be speaking two entirely different
    numeric languages about the exact same answers -- raw ML softmax
    output tops out wherever the model's own scale happens to land it,
    while the final result (predict_with_ml, see below) reports the
    calibrated, coverage-aware confidence. That mismatch is what could
    make the evolution chart trend one disease up toward ~45-50% while
    the final result showed a completely different ranking and scale a
    moment later.

    Always using _disease_confidence here -- the same formula the final
    result now uses for every number it displays -- means the trajectory
    the person watches build up during the interview and the result they
    land on at the end are one continuous, consistent story instead of
    two disconnected ones.
    """
    return {d: _disease_confidence(d, answers, asked) for d in DISEASE_SYMPTOM_MAP}


def predict_with_ml(answers: dict) -> dict:
    ensemble = LOADED_MODELS.get("sctd_ensemble")
    le       = LOADED_MODELS.get("sctd_label_encoder")
    cols     = LOADED_MODELS.get("sctd_feature_columns")
    risk_map = LOADED_MODELS.get("sctd_risk_classification")
    if risk_map is None:
        risk_map = RISK_MAP

    yes_count = sum(1 for v in answers.values() if v is True)

    if yes_count < 2:
        return {
            "disease":    None,
            "confidence": 0.0,
            "risk":       "None",
            "all_scores": {},
            "method":     "insufficient_evidence",
        }

    # See the note in compute_score_snapshot() above: `cols` (and sometimes
    # `ensemble`/`le`, depending on how they were serialised) can be a
    # pandas/numpy object for which `bool(...)` is ambiguous rather than
    # simply falsy. Using `is not None` avoids that crash so this function
    # never silently drops into the scoring fallback below just because a
    # boolean check on a loaded, healthy model raised an exception.
    if ensemble is not None and le is not None and cols is not None:
        try:
            feature_cols = list(cols)
            vec = np.array(
                [1.0 if answers.get(c, False) else 0.0 for c in feature_cols]
            ).reshape(1, -1)
            proba = ensemble.predict_proba(vec)[0]
            idx   = int(np.argmax(proba))

            # ml_confidence is the raw softmax probability. It is used ONLY
            # as an "is there enough signal at all" gate below -- it is
            # NOT what gets shown to the person. The ensemble was trained
            # on dense, mostly-complete symptom checklists, but the
            # adaptive engine queries it with a sparse 15-of-79 partial
            # vector every time, which is an input shape the model never
            # calibrated its probabilities against. That mismatch is what
            # made confidence look uniformly low for every disease except
            # whichever one happened to dominate the fixed question
            # budget (see get_next_question's docstring above). The ML
            # model still picks WHICH disease (argmax over classes it was
            # trained to discriminate is exactly what it's good at), but
            # the CONFIDENCE shown uses _disease_confidence -- the same
            # coverage- and specificity-weighted formula used by the
            # scoring fallback -- which was built specifically to reason
            # about partial answer sets correctly. Retraining the ensemble
            # itself with symptom-masking augmentation (so its own
            # probabilities are calibrated for sparse input) is the
            # longer-term fix; this makes the numbers trustworthy in the
            # meantime without waiting on that retrain.
            ml_confidence = float(proba[idx])

            if ml_confidence < 0.15:
                return {
                    "disease":    None,
                    "confidence": ml_confidence,
                    "risk":       "None",
                    "all_scores": {},
                    "method":     "insufficient_evidence",
                }

            # Same substitution for the "other possibilities" list: use ML
            # probability only to decide which classes are worth showing,
            # then display each one's calibrated, partial-answer-aware
            # confidence rather than its raw softmax share.
            top_indices = np.argsort(proba)[::-1][:8]
            all_scores = {
                le.inverse_transform([i])[0]: _disease_confidence(le.inverse_transform([i])[0], answers)
                for i in top_indices
            }
            all_scores = dict(sorted(all_scores.items(), key=lambda x: x[1], reverse=True))

            # The headline diagnosis must be whichever disease has the
            # HIGHEST calibrated confidence -- the same number the
            # differential list displays -- not just whichever class the
            # raw ML softmax happened to rank first via argmax(proba).
            # Those two rankings can disagree once _disease_confidence's
            # coverage/specificity weighting is applied: a class with the
            # single largest raw probability can still end up with a
            # lower calibrated confidence than a class with stronger
            # matched evidence, which previously let a lower-confidence
            # disease be shown as the primary result while a
            # higher-confidence one appeared underneath it in "other
            # possibilities." Reading disease/confidence off the top of
            # the already-sorted all_scores keeps the two in sync.
            disease, confidence = next(iter(all_scores.items()))

            return {
                "disease":    disease,
                "confidence": confidence,
                "risk":       risk_map.get(disease, "Medium"),
                "all_scores": all_scores,
                "method":     "ml",
            }
        except Exception as e:
            logger.warning(
                {"event": "ml_predict_failed", "error": str(e), "error_type": type(e).__name__},
                exc_info=True,
            )

    scores        = {d: score_disease(d, answers) for d in DISEASE_SYMPTOM_MAP}
    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    best_disease, best_score = sorted_scores[0]

    if best_score <= 0:
        return {
            "disease":    None,
            "confidence": 0.0,
            "risk":       "None",
            "all_scores": {},
            "method":     "insufficient_evidence",
        }

    # Same fix as the ML branch above: score_disease's raw weighted-match
    # score is only used to shortlist which 8 diseases are worth showing
    # at all. The headline diagnosis and its confidence must then come
    # from the top of the CALIBRATED, confidence-sorted list below, not
    # from whichever disease happened to have the highest raw score --
    # those two orderings can differ once _disease_confidence's coverage
    # weighting is applied.
    all_scores: Dict[str, float] = {
        d: _disease_confidence(d, answers) for d, _ in sorted_scores[:8]
    }
    all_scores = dict(sorted(all_scores.items(), key=lambda x: x[1], reverse=True))
    best_disease, confidence = next(iter(all_scores.items()))

    return {
        "disease":    best_disease,
        "confidence": confidence,
        "risk":       RISK_MAP.get(best_disease, "Medium"),
        "all_scores": all_scores,
        "method":     "scoring",
    }


# -----------------------------------------------------------------
# RED-FLAG SAFETY NET
#
# Risk level was previously inherited entirely from whichever disease won
# the differential (RISK_MAP.get(best_disease, "Medium") / risk_map.get
# (disease, "Medium") above). That means a genuinely dangerous symptom
# pattern can be present in the answers but get buried if a lower-risk
# disease happens to outscore the dangerous one -- e.g. Heart attack and
# GERD share chest_pain + vomiting, so GERD can win the differential and
# display as "Low Risk" while Heart attack sits unstyled in "Other
# Possibilities" with no urgency cues at all.
#
# RED_FLAG_RULES is an independent layer of hard-coded, clinically
# dangerous symptom patterns, checked directly against the raw answers
# regardless of which disease the model/scoring picked. It never changes
# WHICH disease is reported -- only whether the risk level gets floored
# up to "High" and whether plain-language warnings are attached.
# -----------------------------------------------------------------

RED_FLAG_RULES: List[Dict[str, Any]] = [
    {
        "symptoms": ["chest_pain", "breathlessness"],
        "match":    "all",
        "label":    "Possible heart attack pattern",
        "message":  "Chest pain along with shortness of breath can be a sign of a heart attack and needs urgent medical attention.",
    },
    {
        "symptoms": ["chest_pain", "sweating"],
        "match":    "all",
        "label":    "Possible heart attack pattern",
        "message":  "Chest pain along with sweating can be a sign of a heart attack and needs urgent medical attention.",
    },
    {
        "symptoms": ["weakness_of_one_body_side"],
        "match":    "any",
        "label":    "Possible stroke",
        "message":  "Sudden weakness on one side of the body can be a sign of a stroke and needs emergency care right away.",
    },
    {
        "symptoms": ["coma"],
        "match":    "any",
        "label":    "Loss of consciousness",
        "message":  "Loss of consciousness is a medical emergency and needs immediate attention.",
    },
    {
        "symptoms": ["blood_in_sputum"],
        "match":    "any",
        "label":    "Coughing blood",
        "message":  "Coughing up blood can be a sign of a serious underlying condition and needs prompt medical evaluation.",
    },
    {
        "symptoms": ["stomach_bleeding"],
        "match":    "any",
        "label":    "Internal bleeding",
        "message":  "Stomach bleeding can be a sign of internal bleeding and needs urgent medical attention.",
    },
    {
        "symptoms": ["stiff_neck", "headache", "high_fever"],
        "match":    "all",
        "label":    "Possible meningitis pattern",
        "message":  "A stiff neck together with headache and high fever can be a sign of meningitis, which can become life-threatening within hours.",
    },
]


def apply_red_flag_rules(pred: dict, answers: dict) -> dict:
    """
    Checks the raw answers against RED_FLAG_RULES independently of
    whichever disease predict_with_ml() landed on. If any rule fires,
    this raises pred["risk"] to "High" (it only ever raises, never
    lowers, the risk level) and attaches the fired rules' plain-language
    messages as pred["red_flags"]. pred["disease"] is left untouched --
    the predicted condition name stays whatever the model/scoring
    produced; only the risk level and an added warning are affected.
    """
    fired_messages: List[str] = []
    for rule in RED_FLAG_RULES:
        symptoms = rule["symptoms"]
        if rule.get("match") == "any":
            matched = any(answers.get(s) is True for s in symptoms)
        else:
            matched = all(answers.get(s) is True for s in symptoms)
        if matched:
            fired_messages.append(rule["message"])

    if fired_messages:
        if pred.get("risk") != "High":
            pred["risk"] = "High"
        pred["red_flags"] = fired_messages
    else:
        pred["red_flags"] = []

    return pred


# -----------------------------------------------------------------
# OPENROUTER AI
# -----------------------------------------------------------------

_RETRY_BASE  = 1.0
_RETRY_MAX   = 10.0
_RETRY_TIMES = 2


async def _do_openrouter_request(headers: dict, payload: dict) -> Optional[dict]:
    async with aiohttp.ClientSession() as session:
        async with session.post(
            settings.openrouter_url,
            headers=headers,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            if resp.status >= 500:
                body = await resp.text()
                OPENROUTER_ERRORS.labels(reason="5xx").inc()
                logger.warning({"event": "openrouter_5xx", "status": resp.status, "body": body[:200]})
                raise aiohttp.ClientResponseError(
                    resp.request_info, resp.history, status=resp.status
                )
            if resp.status != 200:
                logger.warning({"event": "openrouter_non200", "status": resp.status})
                return None
            data   = await resp.json()
            raw    = data["choices"][0]["message"]["content"].strip()
            raw    = raw.replace("```json", "").replace("```", "").strip()
            result = json.loads(raw)
            for key in ("explanation", "home_care", "test", "doctor", "safety"):
                if key not in result:
                    result[key] = ""
            return result


async def _call_openrouter_through_breaker(headers: dict, payload: dict) -> Optional[dict]:
    """
    Routes the actual HTTP call through the module-level circuit breaker so
    repeated OpenRouter failures actually open the breaker (and short-circuit
    further calls until reset_timeout elapses) instead of the breaker object
    sitting unused while every call goes straight to the network.
    """
    if hasattr(_openrouter_cb, "call_async"):
        return await _openrouter_cb.call_async(_do_openrouter_request, headers, payload)
    # Fallback for pybreaker versions without call_async: manually honour
    # breaker state around the async call.
    if _openrouter_cb.current_state == "open":
        raise pybreaker.CircuitBreakerError("Circuit breaker is open")
    try:
        result = await _do_openrouter_request(headers, payload)
    except Exception:
        _openrouter_cb._state_storage.increment_counter()
        raise
    else:
        _openrouter_cb._state_storage.reset_counter()
        return result


async def call_openrouter(
    disease: str,
    risk: str,
    active_syms: List[str],
    confidence: float,
) -> Optional[dict]:
    if not settings.openrouter_api_key:
        logger.info({"event": "openrouter_skip", "reason": "no api key"})
        return None

    cache_key = f"ai_response:{disease}"
    if settings.enable_ai_cache:
        cached = await cache_get(cache_key, key_type="ai_response")
        if cached:
            try:
                return json.loads(cached)
            except Exception:
                pass

    sym_text = ", ".join(s.replace("_", " ") for s in active_syms[:12]) or "general symptoms"
    urgency  = {
        "High":   "URGENT - recommend visiting a hospital or clinic today",
        "Medium": "advise a clinic visit within 1-2 days if symptoms persist",
        "Low":    "advise rest at home and a clinic visit only if symptoms worsen",
    }.get(risk, "advise a clinic visit")

    prompt = f"""You are a health assistant helping patients in Ghana and West Africa.

Patient symptoms: {sym_text}
Likely condition: {disease} (confidence: {round(confidence * 100)}%)
Risk level: {risk} - {urgency}

Reply ONLY with a valid JSON object. No markdown. No extra text. Use this exact format:
{{
  "explanation": "One short sentence on why these symptoms suggest {disease}.",
  "home_care": "1-2 simple things the patient can do at home right now.",
  "test": "One specific lab test or medical test to confirm, or 'No test needed' if not required.",
  "doctor": "One clear instruction - visit hospital, clinic, or pharmacy.",
  "safety": "One brief safety warning if High risk, or empty string if Low/Medium."
}}

Rules:
- Use plain, simple language. No medical jargon.
- Keep each field to one sentence or a short phrase.
- For High risk: always say to visit a hospital or clinic immediately.
- Never invent drug names or dosages."""

    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type":  "application/json",
        "HTTP-Referer":  settings.site_url,
        "X-Title":       settings.site_name,
    }
    payload = {
        "model": settings.openrouter_model,
        "messages": [
            {
                "role":    "system",
                "content": (
                    "You are a responsible clinical AI assistant for a tropical disease app. "
                    "Always respond with valid JSON only. Never prescribe specific drugs or dosages."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "max_tokens":  350,
        "temperature": 0.2,
    }

    last_error: Optional[Exception] = None
    for attempt in range(_RETRY_TIMES + 1):
        try:
            t0     = time.monotonic()
            result = await _call_openrouter_through_breaker(headers, payload)
            OPENROUTER_LATENCY.observe(time.monotonic() - t0)
            if result and settings.enable_ai_cache:
                await cache_set(cache_key, json.dumps(result), ttl=86400)
            return result
        except pybreaker.CircuitBreakerError:
            OPENROUTER_ERRORS.labels(reason="circuit_open").inc()
            logger.warning({"event": "openrouter_circuit_open"})
            fallback = await cache_get(cache_key, key_type="ai_fallback")
            if fallback:
                try:
                    return json.loads(fallback)
                except Exception:
                    pass
            return None
        except asyncio.TimeoutError:
            OPENROUTER_ERRORS.labels(reason="timeout").inc()
            last_error = asyncio.TimeoutError()
            logger.warning({"event": "openrouter_timeout", "attempt": attempt})
        except json.JSONDecodeError as e:
            OPENROUTER_ERRORS.labels(reason="json_parse").inc()
            logger.warning({"event": "openrouter_json_error", "error": str(e)})
            return None
        except aiohttp.ClientError as e:
            OPENROUTER_ERRORS.labels(reason="client_error").inc()
            last_error = e
            logger.warning({"event": "openrouter_client_error", "error": str(e)})
        except Exception as e:
            OPENROUTER_ERRORS.labels(reason="unexpected").inc()
            logger.warning({"event": "openrouter_unexpected", "error": str(e)})
            return None

        if attempt < _RETRY_TIMES:
            wait = min(_RETRY_BASE * (2 ** attempt), _RETRY_MAX)
            logger.info({"event": "openrouter_retry", "wait_s": wait, "attempt": attempt + 1})
            await asyncio.sleep(wait)

    logger.warning({"event": "openrouter_all_retries_failed", "error": str(last_error)})
    return None


def build_recommendation(disease: str, risk: str, ai_result: Optional[dict]) -> dict:
    default = DEFAULT_RECS.get(disease, {
        "home_care": "Rest and stay hydrated.",
        "test":      "Consult a healthcare provider for appropriate tests.",
        "doctor":    "Visit a clinic if symptoms persist or worsen.",
        "safety":    "Seek emergency care if symptoms become severe." if risk == "High" else "",
    })
    if ai_result:
        return {
            "home_care":   ai_result.get("home_care")   or default["home_care"],
            "test":        ai_result.get("test")        or default["test"],
            "doctor":      ai_result.get("doctor")      or default["doctor"],
            "safety":      ai_result.get("safety")      or default.get("safety", ""),
            "explanation": ai_result.get("explanation") or f"Your symptoms are consistent with {disease}.",
        }
    return {**default, "explanation": f"Your symptoms are consistent with {disease}."}


# -----------------------------------------------------------------
# CLINIC FINDER (server-side proxy)
#
# HISTORY: this feature originally queried public Overpass API mirrors
# (racing several free servers concurrently, each with its own timeout,
# plus a curated fallback list for when every mirror failed at once). That
# was unreliable in production for reasons entirely outside our control:
# every app hosted on the same egress IP shares one Overpass rate-limit
# quota, and overpass-api.de specifically failed outright on Render due to
# a broken IPv6 route ("Cannot connect to host overpass-api.de:443
# ssl:default [None]", failing instantly on every attempt).
#
# The feature now calls Geoapify's Places API (https://www.geoapify.com/)
# instead of Overpass. That removes the whole class of problems above at
# the source: it's a single, key-authenticated, reliably-hosted API, so
# there is no shared public quota to exhaust, no need to race multiple
# mirrors against each other, and no IPv4-forcing workaround required.
#
# Results are still cached in Redis per rounded coordinate (unchanged),
# and the curated `_FALLBACK_FACILITIES` list still exists as a safety
# net for the — now much rarer — case where the Geoapify call itself
# fails (missing/invalid API key, network error, non-200 response, or a
# genuinely empty result for that area). It is intentionally never
# written to the live Redis cache, so the very next request still tries
# the live API first and switches back automatically the moment it
# succeeds.
# -----------------------------------------------------------------

GEOAPIFY_PLACES_URL = "https://api.geoapify.com/v2/places"

# healthcare.clinic_or_praxis covers general/walk-in clinics AND doctors'
# offices in Geoapify's taxonomy (there is no separate "doctors" category);
# healthcare.dentist is mapped onto the app's "Doctor's Office" label too,
# since the app has no dedicated "Dentist" type — see
# _classify_geoapify_facility below.
GEOAPIFY_CATEGORIES = "healthcare.hospital,healthcare.clinic_or_praxis,healthcare.pharmacy,healthcare.dentist"

CLINIC_SEARCH_RADIUS_M   = 15000   # every facility type is searched over the same radius, so nothing
                                    # genuinely close to the user is ever silently excluded
CLINIC_FETCH_LIMIT       = 40      # over-fetch beyond CLINIC_RESULTS_LIMIT so ranking-by-distance has a
                                    # real pool spanning every category to pick the nearest facilities
                                    # from, instead of just whatever page the API happened to return first
CLINIC_SOURCE_TIMEOUT_S  = 8       # a single authenticated call now — no per-mirror racing budget needed
                                    # — stays comfortably under the 30s app-wide request timeout
CLINIC_CACHE_TTL_S       = 21600   # 6 hours, unchanged
CLINIC_RESULTS_LIMIT     = 15      # "genuinely nearby, combined across every category"

# Coordinates are approximate (city/campus level), which is sufficient for
# a "here are known major facilities near you" fallback — this list is
# deliberately small and Ghana-focused rather than a full replacement data
# source. Kept tight (not stretched to cover "anywhere in Ghana") so a
# person in Accra is never shown a Kumasi hospital as if it were nearby —
# an honest "nothing found" is better than a misleading "nearby" facility
# that's actually an hours-long drive away.
CLINIC_FALLBACK_MAX_DISTANCE_KM = 25

# The curated fallback list spans hospitals, government polyclinics, and
# pharmacies so a fallback answer still reflects "all kinds of health
# facilities," not just one category. Individual private doctors' offices
# are deliberately NOT included: unlike hospitals/polyclinics/pharmacy
# chains, standalone GP practices have no reliably-documented, stable
# address/coordinate source, and showing a wrong location for a doctor in
# a health app is worse than not showing one at all. That category is
# served from live Geoapify data and simply won't appear when the fallback
# list is what's answering the request.
_FALLBACK_FACILITIES: List[dict] = [
    # Greater Accra — Hospitals
    {"id": "fallback/korle-bu", "name": "Korle Bu Teaching Hospital", "type": "Government Hospital",
     "address": "Guggisberg Ave, Accra", "phone": "", "lat": 5.5365, "lon": -0.2264},
    {"id": "fallback/ridge", "name": "Greater Accra Regional Hospital (Ridge Hospital)", "type": "Government Hospital",
     "address": "Castle Rd, Ridge, Accra", "phone": "", "lat": 5.5701, "lon": -0.1969},
    {"id": "fallback/37-military", "name": "37 Military Hospital", "type": "Government Hospital",
     "address": "Liberation Rd, Accra", "phone": "", "lat": 5.5975, "lon": -0.1751},
    {"id": "fallback/nyaho", "name": "Nyaho Medical Centre", "type": "Private Hospital",
     "address": "Airport Residential Area, Accra", "phone": "", "lat": 5.5679, "lon": -0.1735},
    {"id": "fallback/trust", "name": "Trust Hospital", "type": "Private Hospital",
     "address": "Osu, Accra", "phone": "", "lat": 5.5563, "lon": -0.1735},
    {"id": "fallback/ug-legon", "name": "University of Ghana Hospital", "type": "Government Hospital",
     "address": "Legon, Accra", "phone": "", "lat": 5.6506, "lon": -0.1868},
    {"id": "fallback/lekma", "name": "LEKMA Hospital", "type": "Government Hospital",
     "address": "Teshie, Accra", "phone": "", "lat": 5.6037, "lon": -0.1214},
    # Greater Accra — Clinics (government polyclinics)
    {"id": "fallback/kaneshie-polyclinic", "name": "Kaneshie Polyclinic", "type": "Clinic",
     "address": "Palace St, Kaneshie, Accra", "phone": "0302228288", "lat": 5.5560, "lon": -0.2350},
    # Greater Accra — Pharmacies (Ernest Chemists, Ghana's largest pharmacy chain)
    {"id": "fallback/ernest-chemists-ring-road", "name": "Ernest Chemists — Ring Road Central", "type": "Pharmacy",
     "address": "Ring Road Central, Accra", "phone": "0302908674", "lat": 5.5686, "lon": -0.2010},
    {"id": "fallback/ernest-chemists-east-legon", "name": "Ernest Chemists — East Legon", "type": "Pharmacy",
     "address": "Christian Center, Jungle Ave, East Legon, Accra", "phone": "", "lat": 5.6350, "lon": -0.1600},
    # Kumasi (KNUST)
    {"id": "fallback/kath", "name": "Komfo Anokye Teaching Hospital", "type": "Government Hospital",
     "address": "Bantama, Kumasi", "phone": "", "lat": 6.6975, "lon": -1.6154},
    {"id": "fallback/knust-hospital", "name": "KNUST Hospital (University Health Services)", "type": "Government Hospital",
     "address": "KNUST Campus, Kumasi", "phone": "", "lat": 6.6743, "lon": -1.5716},
    {"id": "fallback/kumasi-south", "name": "Kumasi South Hospital", "type": "Government Hospital",
     "address": "Atonsu, Kumasi", "phone": "", "lat": 6.6650, "lon": -1.6330},
    {"id": "fallback/ernest-chemists-adum", "name": "Ernest Chemists — Adum", "type": "Pharmacy",
     "address": "Adum, Kumasi", "phone": "", "lat": 6.6885, "lon": -1.6244},
    # Other regional capitals
    {"id": "fallback/tamale-teaching", "name": "Tamale Teaching Hospital", "type": "Government Hospital",
     "address": "Tamale", "phone": "", "lat": 9.4075, "lon": -0.8393},
    {"id": "fallback/cape-coast-teaching", "name": "Cape Coast Teaching Hospital", "type": "Government Hospital",
     "address": "Cape Coast", "phone": "", "lat": 5.1315, "lon": -1.2795},
]

# Terms that reliably indicate government/public ownership in OSM data for
# Ghanaian and West African facilities (Ministry of Health, regional/district
# hospitals, teaching hospitals run by public universities, etc). Geoapify
# passes the underlying OSM tags through under properties.datasource.raw
# for OSM-sourced places, so these terms apply there exactly as they did
# against raw Overpass tags.
_GOV_OPERATOR_TYPE_TERMS = {"government", "public", "national", "state", "municipal"}
_GOV_OPERATOR_NAME_HINTS = (
    "ministry of health", "moh", "government", "municipal", "district assembly",
    "regional hospital", "district hospital", "teaching hospital", "national health",
)
_PRIVATE_OPERATOR_TYPE_TERMS = {"private", "ngo", "religious", "community", "cooperative"}


def _classify_geoapify_facility(properties: dict) -> str:
    """
    Maps a Geoapify Places `properties` object to a clean, user-facing
    facility category, mirroring the app's existing type labels
    ("Government Hospital", "Private Hospital", "Hospital", "Clinic",
    "Doctor's Office", "Pharmacy"). Hospitals are further split into
    Government / Private where OSM ownership tags (passed through under
    properties.datasource.raw for OSM-sourced places) or well-known
    operator name patterns make that determination possible; otherwise
    they fall back to a neutral "Hospital" label rather than guessing
    ownership without evidence.
    """
    categories = properties.get("categories") or []
    raw = (properties.get("datasource") or {}).get("raw") or {}
    raw_amenity = (raw.get("amenity") or "").strip().lower()
    raw_healthcare = (raw.get("healthcare") or "").strip().lower()

    def _has_category(prefix: str) -> bool:
        return any(c == prefix or c.startswith(prefix + ".") for c in categories)

    if raw_amenity == "hospital" or _has_category("healthcare.hospital"):
        operator_type = (raw.get("operator:type") or raw.get("ownership") or "").strip().lower()
        operator_name = (raw.get("operator") or properties.get("name") or "").strip().lower()

        if operator_type in _GOV_OPERATOR_TYPE_TERMS:
            return "Government Hospital"
        if operator_type in _PRIVATE_OPERATOR_TYPE_TERMS:
            return "Private Hospital"
        if any(hint in operator_name for hint in _GOV_OPERATOR_NAME_HINTS):
            return "Government Hospital"
        return "Hospital"

    # Geoapify has no standalone "doctors" category — general practices
    # fall under healthcare.clinic_or_praxis (handled below as "Clinic")
    # unless the underlying OSM tag says otherwise, or the place is a
    # dentist, which the app's type set has no dedicated label for either.
    if raw_amenity == "doctors" or _has_category("healthcare.dentist"):
        return "Doctor's Office"

    if raw_amenity == "pharmacy" or raw_healthcare == "pharmacy" or _has_category("healthcare.pharmacy"):
        return "Pharmacy"

    if raw_amenity == "clinic" or _has_category("healthcare.clinic_or_praxis"):
        return "Clinic"

    return "Health Facility"


async def _fetch_geoapify_features(lat: float, lon: float) -> List[dict]:
    """
    Single call to Geoapify Places — replaces the old multi-mirror Overpass
    race entirely (see HISTORY above). No IPv4 forcing, no per-mirror
    timeout budget, no User-Agent spoofing needed: Geoapify is a normal
    key-authenticated HTTPS API, so one aiohttp call with one timeout is
    all this needs. Returns raw GeoJSON features (or an empty list on any
    failure) — extraction into the app's place shape happens separately in
    _extract_geoapify_places, mirroring the old two-step fetch/extract
    pattern.
    """
    if not settings.geoapify_api_key:
        CLINIC_SOURCE_ERRORS.labels(source="geoapify", reason="missing_api_key").inc()
        logger.warning({"event": "geoapify_error", "reason": "missing_api_key", "lat": lat, "lon": lon})
        return []

    params = {
        "categories": GEOAPIFY_CATEGORIES,
        "filter": f"circle:{lon},{lat},{CLINIC_SEARCH_RADIUS_M}",
        "bias": f"proximity:{lon},{lat}",
        "limit": str(CLINIC_FETCH_LIMIT),
        "apiKey": settings.geoapify_api_key,
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                GEOAPIFY_PLACES_URL,
                params=params,
                timeout=aiohttp.ClientTimeout(total=CLINIC_SOURCE_TIMEOUT_S),
            ) as resp:
                if resp.status != 200:
                    body_snippet = (await resp.text())[:300]
                    CLINIC_SOURCE_ERRORS.labels(source="geoapify", reason=f"http_{resp.status}").inc()
                    logger.warning({
                        "event": "geoapify_error",
                        "reason": f"http_{resp.status}",
                        "status": resp.status,
                        "lat": lat, "lon": lon,
                        "body": body_snippet,
                    })
                    return []

                data = await resp.json()
                features = data.get("features", [])
                if not features:
                    # A genuinely empty result for this area is not an
                    # error — no separate geoapify_error log for this case,
                    # same nuance the old Overpass code applied to a
                    # remark-free empty response.
                    CLINIC_SOURCE_ERRORS.labels(source="geoapify", reason="empty").inc()
                return features
    except asyncio.TimeoutError:
        CLINIC_SOURCE_ERRORS.labels(source="geoapify", reason="timeout").inc()
        logger.warning({"event": "geoapify_error", "reason": "timeout", "lat": lat, "lon": lon})
        return []
    except Exception as e:
        CLINIC_SOURCE_ERRORS.labels(source="geoapify", reason="error").inc()
        logger.warning({"event": "geoapify_error", "reason": "error", "error": str(e), "lat": lat, "lon": lon})
        return []


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _extract_geoapify_places(features: List[dict]) -> List[dict]:
    """
    Extracts facility name/type/address/coordinates from a Geoapify Places
    GeoJSON FeatureCollection into the SAME shape the rest of this feature
    already expects — {id, name, type, address, phone, lat, lon} — so
    _rank_places_by_distance, the Redis caching layer, and the
    _FALLBACK_FACILITIES safety net all keep working completely unchanged.

    Deliberately no distance calculation here — this is the shape that
    gets cached, and a cached facility list must remain valid no matter
    which nearby coordinate a future request comes from. Distance is
    always computed fresh in _rank_places_by_distance.
    """
    places: List[dict] = []
    seen: set = set()

    for feature in features:
        properties = feature.get("properties") or {}
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        lon = coords[0] if len(coords) > 0 else properties.get("lon")
        lat = coords[1] if len(coords) > 1 else properties.get("lat")
        if lat is None or lon is None:
            continue

        name = properties.get("name") or "Unnamed facility"
        facility_type = _classify_geoapify_facility(properties)

        address = ", ".join(
            p for p in (properties.get("address_line1"), properties.get("address_line2")) if p
        ) or (properties.get("formatted") or "")

        raw = (properties.get("datasource") or {}).get("raw") or {}
        phone = raw.get("phone") or raw.get("contact:phone") or properties.get("phone") or ""

        place_id = properties.get("place_id") or feature.get("id")
        dedupe_key = f"{name}-{round(lat, 5)}-{round(lon, 5)}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        places.append({
            "id":      f"geoapify/{place_id}" if place_id else dedupe_key,
            "name":    name,
            "type":    facility_type,
            "address": address,
            "phone":   phone,
            "lat":     lat,
            "lon":     lon,
        })

    return places


def _rank_places_by_distance(
    places: List[dict], user_lat: float, user_lon: float, limit: int = 20
) -> List[dict]:
    """
    Computes distance from the exact coordinates of this specific request
    and sorts by it. Called on every request — cache hit or miss — so
    "nearest" is always correct for wherever the person actually is right
    now, never a stale distance from whatever coordinates first populated
    the cache. Both hospitals and local facilities are now fetched over the
    same radius (see FIX #2 above), so ranking is purely by actual
    distance — exactly like Google Maps / Uber do — with no category ever
    silently excluded from consideration.
    """
    ranked = [
        {**p, "distance_km": round(_haversine_km(user_lat, user_lon, p["lat"], p["lon"]), 2)}
        for p in places
    ]
    ranked.sort(key=lambda p: p["distance_km"])
    return ranked[:limit]


# -----------------------------------------------------------------
# PYDANTIC SCHEMAS
# -----------------------------------------------------------------

class RegisterRequest(BaseModel):
    # EmailStr enforces a valid email shape server-side. The frontend's
    # regex check is a UX nicety only -- anyone calling this endpoint
    # directly (curl, Postman, a script) bypasses it entirely, so the
    # server must not trust client-side validation alone.
    email:    EmailStr
    password: str
    name:     str
    age:      Optional[str] = None
    gender:   Optional[str] = None
    # Optional so any existing client that doesn't send it still registers
    # exactly as before, defaulting to a self-screening "patient" account.
    role:     Optional[str] = "patient"


class LoginRequest(BaseModel):
    email:    EmailStr
    password: str


class GoogleAuthRequest(BaseModel):
    access_token: str
    # Only used the first time this email signs in (i.e. when the account
    # is created) -- ignored for a returning user, whose role was already
    # decided at signup and must not silently change on a later login.
    role: Optional[str] = None


class FacebookAuthRequest(BaseModel):
    access_token: str
    role: Optional[str] = None


class AppleAuthRequest(BaseModel):
    id_token: str
    name: Optional[str] = None  # Apple only ever sends this on first authorization
    role: Optional[str] = None


class AnswerRequest(BaseModel):
    question_id: str
    answer:      bool
    # Optional, must match the session's own patient_id when provided (the
    # session already carries it from /symptoms/start) -- included here so
    # every step of the flow can be explicit about which patient it's for.
    patient_id:  Optional[int] = None


class PatientCreateRequest(BaseModel):
    name:          str
    age:           Optional[int] = None
    gender:        Optional[str] = None
    community:     Optional[str] = None
    consent_given: bool = False


class ProfileUpdate(BaseModel):
    name:   Optional[str] = None
    age:    Optional[str] = None
    gender: Optional[str] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password:     str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token:        str
    new_password: str


# -----------------------------------------------------------------
# AUTH HELPERS
# -----------------------------------------------------------------

security = HTTPBearer()


def create_token(user_id: int) -> str:
    exp = datetime.utcnow() + timedelta(days=settings.access_token_expire_days)
    return jwt.encode({"sub": str(user_id), "exp": exp}, settings.secret_key, algorithm=settings.algorithm)


def verify_token(creds: HTTPAuthorizationCredentials = Depends(security)) -> int:
    try:
        payload = jwt.decode(creds.credentials, settings.secret_key, algorithms=[settings.algorithm])
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token payload")
        return int(user_id)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def verify_admin(user_id: int = Depends(verify_token)) -> int:
    if user_id != settings.admin_user_id:
        raise HTTPException(status_code=403, detail="Admin access only")
    return user_id


def _require_worker(user_id: int, db: Session) -> UserModel:
    """Loads the authenticated user and confirms they are a health worker."""
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user or user.role != "worker":
        raise HTTPException(status_code=403, detail="Worker access only")
    return user


def hash_pw(pw: str) -> str:
    salt   = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 260_000).hex()
    return f"{salt}:{hashed}"


def verify_pw(pw: str, stored: str) -> bool:
    try:
        parts = stored.split(":", 1)
        if len(parts) != 2:
            return False
        salt, hashed = parts
        pbkdf2_result = hashlib.pbkdf2_hmac(
            "sha256", pw.encode(), salt.encode(), 260_000
        ).hex()
        if pbkdf2_result == hashed:
            return True
        legacy_result = hashlib.sha256((salt + pw).encode()).hexdigest()
        if legacy_result == hashed:
            return True
        return False
    except Exception:
        return False


# -----------------------------------------------------------------
# SOCIAL SIGN-IN HELPERS
# -----------------------------------------------------------------
# Google and Facebook use "access tokens": the frontend obtains one from the
# provider's SDK and we exchange it, server-side, for the user's verified
# profile by calling the provider's own API. Apple only issues a signed
# "id_token" (a JWT), which we verify ourselves against Apple's published
# public keys (JWKS) rather than calling an API for every login.
# -----------------------------------------------------------------

_JWKS_CACHE: Dict[str, Dict[str, Any]] = {}
_JWKS_TTL_SECONDS = 3600


async def _get_jwks(jwks_url: str) -> dict:
    cached = _JWKS_CACHE.get(jwks_url)
    if cached and (time.time() - cached["fetched_at"]) < _JWKS_TTL_SECONDS:
        return cached["data"]
    async with aiohttp.ClientSession() as s:
        async with s.get(jwks_url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=503, detail="Unable to reach identity provider. Please try again.")
            data = await resp.json()
    _JWKS_CACHE[jwks_url] = {"data": data, "fetched_at": time.time()}
    return data


async def _verify_oidc_id_token(id_token: str, jwks_url: str, issuers: set[str], audience: str) -> dict:
    try:
        header = jwt.get_unverified_header(id_token)
    except JWTError:
        raise HTTPException(status_code=401, detail="Malformed identity token")

    kid = header.get("kid")
    jwks = await _get_jwks(jwks_url)
    key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)

    if key is None:
        # Provider may have rotated its signing keys — refresh once and retry.
        _JWKS_CACHE.pop(jwks_url, None)
        jwks = await _get_jwks(jwks_url)
        key = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)

    if key is None:
        raise HTTPException(status_code=401, detail="Unable to verify identity token")

    try:
        payload = jwt.decode(
            id_token,
            key,
            algorithms=[key.get("alg", "RS256")],
            audience=audience,
        )
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired identity token")

    if payload.get("iss") not in issuers:
        raise HTTPException(status_code=401, detail="Identity token has an unexpected issuer")

    return payload


async def verify_google_access_token(access_token: str) -> dict:
    if not settings.google_client_id:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured on the server")

    async with aiohttp.ClientSession() as s:
        async with s.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"access_token": access_token},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            token_info = await resp.json()
            if resp.status != 200 or token_info.get("aud") != settings.google_client_id:
                raise HTTPException(status_code=401, detail="Invalid Google access token")

        async with s.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=401, detail="Unable to fetch Google profile")
            profile = await resp.json()

    return profile


async def verify_facebook_access_token(access_token: str) -> dict:
    if not settings.facebook_app_id or not settings.facebook_app_secret:
        raise HTTPException(status_code=503, detail="Facebook sign-in is not configured on the server")

    app_token = f"{settings.facebook_app_id}|{settings.facebook_app_secret}"

    async with aiohttp.ClientSession() as s:
        async with s.get(
            "https://graph.facebook.com/debug_token",
            params={"input_token": access_token, "access_token": app_token},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            debug = (await resp.json()).get("data", {})
            if not debug.get("is_valid") or str(debug.get("app_id")) != str(settings.facebook_app_id):
                raise HTTPException(status_code=401, detail="Invalid Facebook access token")

        async with s.get(
            "https://graph.facebook.com/me",
            params={"fields": "id,name,email", "access_token": access_token},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            profile = await resp.json()
            if "error" in profile:
                raise HTTPException(status_code=401, detail="Unable to fetch Facebook profile")

    return profile


async def verify_apple_id_token(id_token: str) -> dict:
    if not settings.apple_client_id:
        raise HTTPException(status_code=503, detail="Apple sign-in is not configured on the server")

    return await _verify_oidc_id_token(
        id_token,
        jwks_url="https://appleid.apple.com/auth/keys",
        issuers={"https://appleid.apple.com"},
        audience=settings.apple_client_id,
    )


def _user_response(user: "UserModel") -> dict:
    """
    Canonical shape for the "user" object returned by every auth entry
    point (register, login, Google/Facebook/Apple). Mirrors the fields
    GET /api/v1/user/profile returns for the same user, so age, gender,
    and role are locked in on the client the moment someone registers or
    logs in -- instead of only appearing after a later profile fetch.
    """
    return {
        "id":     user.id,
        "email":  user.email,
        "name":   user.name,
        "age":    user.age,
        "gender": user.gender,
        "role":   user.role or "patient",
    }


def _oauth_token_response(user: "UserModel") -> dict:
    return {
        "access_token": create_token(user.id),
        "token_type":   "bearer",
        "user":         _user_response(user),
    }


def _find_or_create_oauth_user(
    db: Session, email: str, name: str, provider: str, oauth_sub: str, role: Optional[str] = None
) -> "UserModel":
    clean_email = _sanitize(email.strip().lower())
    clean_name  = _sanitize(name.strip()) if name and name.strip() else clean_email.split("@")[0]
    # Only a validated role is honored, and only for a brand-new account --
    # an unrecognized value (or none at all) falls back to the same
    # "patient" default a plain email/password signup gets.
    clean_role = role if role in ("patient", "worker") else "patient"

    user = db.query(UserModel).filter(UserModel.email == clean_email).first()
    if user is None:
        user = UserModel(
            email=clean_email,
            name=clean_name,
            pw_hash=None,
            auth_provider=provider,
            oauth_sub=oauth_sub,
            role=clean_role,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    elif not user.auth_provider:
        # Existing email/password account signing in with a provider for the
        # first time — link the provider without touching their password or
        # their existing role.
        user.auth_provider = provider
        user.oauth_sub = oauth_sub
        db.commit()

    return user


# -----------------------------------------------------------------
# RATE LIMITER
# -----------------------------------------------------------------

limiter = Limiter(key_func=get_remote_address, enabled=settings.enable_rate_limiting)


# -----------------------------------------------------------------
# BACKGROUND SCHEDULER
# -----------------------------------------------------------------

_scheduler = AsyncIOScheduler()


async def _cleanup_stale_sessions() -> None:
    cutoff = datetime.utcnow() - timedelta(hours=2)
    db = SessionLocal()
    try:
        deleted = (
            db.query(SessionModel)
            .filter(
                SessionModel.completed == False,
                SessionModel.created_at < cutoff,
            )
            .delete(synchronize_session=False)
        )
        db.commit()
        SESSION_CLEANUP_RUNS.inc()
        logger.info({"event": "session_cleanup", "deleted": deleted})
    except Exception as e:
        logger.error({"event": "session_cleanup_error", "error": str(e)})
        db.rollback()
    finally:
        db.close()


# -----------------------------------------------------------------
# LIFESPAN
# -----------------------------------------------------------------

_pending_requests: int = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    run_schema_migrations()
    load_ml_models()
    start_model_watcher()

    await get_redis()

    _scheduler.add_job(_cleanup_stale_sessions, "interval", hours=1, id="session_cleanup")
    _scheduler.start()

    model_keys    = list(LOADED_MODELS.keys())
    required_keys = {"sctd_ensemble", "sctd_label_encoder", "sctd_feature_columns"}
    missing_keys  = sorted(required_keys - set(model_keys))
    if missing_keys:
        logger.error({
            "event":   "ml_models_incomplete",
            "found":   model_keys or ["none - using scoring engine"],
            "missing": missing_keys,
            "impact":  "Every diagnosis will use the symptom-scoring fallback, not the trained ensemble.",
        })
    logger.info({
        "event":       "startup",
        "ml_models":   model_keys or ["none - using scoring engine"],
        "ml_ready":    not missing_keys,
        "openrouter":  bool(settings.openrouter_api_key),
    })

    yield

    logger.info({"event": "shutdown_initiated"})
    deadline = asyncio.get_event_loop().time() + 30
    while _pending_requests > 0 and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.5)

    _scheduler.shutdown(wait=False)
    stop_model_watcher()
    r = await get_redis()
    if r:
        await r.close()
    engine.dispose()
    logger.info({"event": "shutdown_complete"})


# -----------------------------------------------------------------
# APP
# -----------------------------------------------------------------

app = FastAPI(
    title="TropiCare API",
    version="1.0.0",
    description="KNUST Final Year Project - AI Tropical Disease Checker",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(GZipMiddleware, minimum_size=1024)

# -----------------------------------------------------------------
# FIX: CORS — allow_credentials=True is incompatible with origins=["*"].
# When a specific origin list is provided via ALLOWED_ORIGINS env var,
# use it with credentials. When it is literally "*", switch to
# allow_credentials=False so browsers do not reject the preflight.
# -----------------------------------------------------------------
_origins = settings.origins_list
if _origins == ["*"]:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

Instrumentator().instrument(app).expose(app, endpoint="/metrics")

# -----------------------------------------------------------------
# MIDDLEWARE
# -----------------------------------------------------------------

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _sanitize(value: str) -> str:
    return _CONTROL_CHAR_RE.sub("", value)


@app.middleware("http")
async def request_middleware(request: Request, call_next):
    global _pending_requests  # noqa: F824 - mutated below via += / -=

    if request.method == "OPTIONS":
        return await call_next(request)

    req_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    request.state.request_id = req_id

    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > settings.max_body_size:
        return JSONResponse(
            status_code=413,
            content={"detail": "Request body too large"},
            headers={"X-Request-ID": req_id},
        )

    if request.method in ("POST", "PUT", "PATCH"):
        ct = request.headers.get("content-type", "")
        if ct and "application/json" not in ct and "multipart" not in ct:
            return JSONResponse(
                status_code=415,
                content={"detail": "Content-Type must be application/json"},
                headers={"X-Request-ID": req_id},
            )

    start = time.monotonic()
    _pending_requests += 1

    user_id_log: Optional[int] = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        try:
            token = auth_header[7:]
            payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
            user_id_log = int(payload.get("sub", 0)) or None
        except Exception:
            pass

    try:
        response: Response = await asyncio.wait_for(call_next(request), timeout=30)
    except asyncio.TimeoutError:
        _pending_requests -= 1
        return JSONResponse(
            status_code=504,
            content={"detail": "Request timed out"},
            headers={"X-Request-ID": req_id},
        )
    finally:
        _pending_requests -= 1

    duration_ms = round((time.monotonic() - start) * 1000, 2)

    response.headers["X-Request-ID"]           = req_id
    response.headers["X-Content-Type-Options"]  = "nosniff"
    response.headers["X-Frame-Options"]         = "DENY"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

    # FIX: replaced "default-src 'none'" which blocked every browser request
    # from the Vercel frontend. The policy now allows:
    #   - API calls back to this server and the Vercel frontend origin
    #   - Inline scripts/styles that React injects
    #   - Google Fonts used by the frontend
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "connect-src 'self' https://tropicare.onrender.com https://*.vercel.app; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; "
        "frame-ancestors 'none';"
    )

    if user_id_log:
        response.headers["Cache-Control"] = "no-store"

    logger.info({
        "event":       "request",
        "request_id":  req_id,
        "method":      request.method,
        "path":        request.url.path,
        "status":      response.status_code,
        "duration_ms": duration_ms,
        "user_id":     user_id_log,
    })

    return response


# -----------------------------------------------------------------
# PASSWORD RATE LIMITING
# -----------------------------------------------------------------

async def _check_password_rate_limit(email: str) -> None:
    r = await get_redis()
    if r is None:
        return
    key = f"pw_attempts:{email}"
    try:
        count = await r.incr(key)
        if count == 1:
            await r.expire(key, 60)
        if count > 3:
            raise HTTPException(
                status_code=429,
                detail="Too many login attempts. Try again in a minute.",
                headers={"Retry-After": "60"},
            )
    except HTTPException:
        raise
    except Exception:
        pass


async def _check_reset_rate_limit(email: str) -> None:
    """
    Caps how often a password reset can be requested for one email address,
    independent of the per-IP @limiter.limit on the route itself. Without
    this, one IP hitting the per-IP limit doesn't stop someone from
    spamming a *specific* victim's inbox with reset emails from many IPs.
    Fails open (no Redis -> no extra limit) since the per-IP limiter still
    applies either way.
    """
    r = await get_redis()
    if r is None:
        return
    key = f"pw_reset_req:{email}"
    try:
        count = await r.incr(key)
        if count == 1:
            await r.expire(key, 3600)
        if count > 3:
            raise HTTPException(
                status_code=429,
                detail="Too many reset requests for this email. Please try again later.",
                headers={"Retry-After": "3600"},
            )
    except HTTPException:
        raise
    except Exception:
        pass


# -----------------------------------------------------------------
# EMAIL DELIVERY
#
# Plain smtplib over the standard SMTP protocol -- works unmodified with
# Gmail/Google Workspace, Outlook/Microsoft 365, SendGrid, Mailgun,
# Postmark and Amazon SES (all of them expose an SMTP endpoint), so
# switching providers in production is a matter of changing environment
# variables, not code. smtplib is blocking, so the actual send runs in a
# worker thread via run_in_executor and is scheduled through
# BackgroundTasks from the route -- the API responds immediately and
# never makes a user wait on a mail server's round-trip.
# -----------------------------------------------------------------

def _send_email_sync(to_email: str, subject: str, html_body: str, text_body: str) -> bool:
    import smtplib
    import ssl
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    if not settings.smtp_host:
        # Not configured (e.g. local development). Log the content instead
        # of silently pretending to send it, so the flow is still visible
        # and testable end to end with zero mail-server setup.
        logger.warning({
            "event":   "email_not_configured",
            "to":      to_email,
            "subject": subject,
        })
        return False

    from_email = settings.smtp_from_email or settings.smtp_username
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"{settings.smtp_from_name} <{from_email}>"
    msg["To"]      = to_email
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    try:
        context = ssl.create_default_context()
        # Port 465 is implicit TLS -- the connection itself is encrypted
        # from the first byte, and calling STARTTLS on it fails (it's a
        # plaintext-upgrade command that doesn't exist inside an already-
        # encrypted session). Every other port (587 is the near-universal
        # default across Gmail/Workspace, Outlook, SendGrid, Mailgun,
        # Postmark and SES) uses STARTTLS: connect in plaintext, then
        # upgrade. Branching on the port -- rather than trusting
        # smtp_use_tls alone -- means a 465 misconfiguration can't
        # silently produce a confusing STARTTLS error.
        if settings.smtp_port == 465:
            server_ctx = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=10, context=context)
        else:
            server_ctx = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10)
        with server_ctx as server:
            if settings.smtp_port != 465 and settings.smtp_use_tls:
                server.starttls(context=context)
            if settings.smtp_username:
                server.login(settings.smtp_username, settings.smtp_password)
            server.sendmail(from_email, [to_email], msg.as_string())
        logger.info({"event": "email_sent", "to": to_email, "subject": subject})
        return True
    except Exception as e:
        logger.error({"event": "email_send_failed", "to": to_email, "error": str(e)})
        return False


async def send_email(to_email: str, subject: str, html_body: str, text_body: str) -> bool:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _send_email_sync, to_email, subject, html_body, text_body)


def _reset_email_bodies(name: str, reset_link: str, expire_minutes: int) -> tuple[str, str]:
    """Returns (html_body, text_body) for the password-reset email."""
    first_name = (name or "there").split(" ")[0]
    html = f"""\
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f4f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f9;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(11,23,38,0.08);">
            <tr>
              <td style="background:#0c8a7e;padding:28px 32px;text-align:center;">
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.02em;">TropiCare</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 32px 8px;">
                <p style="margin:0 0 16px;color:#0b1726;font-size:15px;line-height:1.6;">Hi {first_name},</p>
                <p style="margin:0 0 24px;color:#0b1726;font-size:15px;line-height:1.6;">
                  We received a request to reset the password on your TropiCare account.
                  Click the button below to choose a new one.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                  <tr>
                    <td style="border-radius:10px;background:#0c8a7e;">
                      <a href="{reset_link}" style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:10px;">
                        Reset Password
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;color:#5b6b7c;font-size:13px;line-height:1.6;">
                  This link expires in {expire_minutes} minutes. If the button above doesn't work, copy and paste this URL into your browser:
                </p>
                <p style="margin:0 0 24px;color:#0c8a7e;font-size:12.5px;line-height:1.6;word-break:break-all;">{reset_link}</p>
                <p style="margin:0;color:#90a0ae;font-size:12.5px;line-height:1.6;">
                  If you didn't request a password reset, you can safely ignore this email -- your password will not be changed.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px;border-top:1px solid #eef2f5;">
                <p style="margin:0;color:#90a0ae;font-size:11.5px;line-height:1.5;">
                  TropiCare · Guided symptom assessment for tropical diseases
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
    text = (
        f"Hi {first_name},\n\n"
        "We received a request to reset the password on your TropiCare account.\n\n"
        f"Reset your password using this link (expires in {expire_minutes} minutes):\n{reset_link}\n\n"
        "If you didn't request this, you can safely ignore this email -- your password will not be changed.\n\n"
        "-- TropiCare"
    )
    return html, text


def _no_password_account_email_bodies(name: str, provider: str) -> tuple[str, str]:
    """
    Sent instead of a reset link when the email on file belongs to an
    account created via Google/Facebook/Apple and has no password to
    reset. Tells the person how they actually sign in rather than
    leaving them stuck on a link that could never have worked.
    """
    first_name = (name or "there").split(" ")[0]
    provider_label = {"google": "Google", "facebook": "Facebook", "apple": "Apple"}.get(provider, "a social account")
    html = f"""\
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f4f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f9;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(11,23,38,0.08);">
            <tr>
              <td style="background:#0c8a7e;padding:28px 32px;text-align:center;">
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.02em;">TropiCare</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;color:#0b1726;font-size:15px;line-height:1.6;">Hi {first_name},</p>
                <p style="margin:0 0 16px;color:#0b1726;font-size:15px;line-height:1.6;">
                  We received a password reset request for this email address, but your TropiCare account was created using
                  <strong>{provider_label}</strong> sign-in and doesn't have a password.
                </p>
                <p style="margin:0;color:#5b6b7c;font-size:13.5px;line-height:1.6;">
                  Please sign in to TropiCare using the "{provider_label}" option instead. If you didn't request this, you can safely ignore this email.
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
    text = (
        f"Hi {first_name},\n\n"
        "We received a password reset request for this email address, but your TropiCare account was created using "
        f"{provider_label} sign-in and doesn't have a password.\n\n"
        f"Please sign in to TropiCare using the \"{provider_label}\" option instead.\n\n"
        "If you didn't request this, you can safely ignore this email.\n\n"
        "-- TropiCare"
    )
    return html, text


def _password_changed_email_bodies(name: str) -> tuple[str, str]:
    """Security notification sent after a password reset actually completes."""
    first_name = (name or "there").split(" ")[0]
    html = f"""\
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f4f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f9;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(11,23,38,0.08);">
            <tr>
              <td style="background:#0c8a7e;padding:28px 32px;text-align:center;">
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.02em;">TropiCare</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;color:#0b1726;font-size:15px;line-height:1.6;">Hi {first_name},</p>
                <p style="margin:0 0 16px;color:#0b1726;font-size:15px;line-height:1.6;">
                  This confirms your TropiCare password was just changed.
                </p>
                <p style="margin:0;color:#5b6b7c;font-size:13.5px;line-height:1.6;">
                  If you made this change, no action is needed. If you didn't, please contact support right away.
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
    text = (
        f"Hi {first_name},\n\n"
        "This confirms your TropiCare password was just changed.\n\n"
        "If you made this change, no action is needed. If you didn't, please contact support right away.\n\n"
        "-- TropiCare"
    )
    return html, text


# -----------------------------------------------------------------
# HEALTH ENDPOINTS
# -----------------------------------------------------------------

@app.get("/api/v1/health")
async def health():
    required = {"sctd_ensemble", "sctd_label_encoder", "sctd_feature_columns"}
    found    = set(LOADED_MODELS.keys())
    return {
        "status":             "healthy",
        "timestamp":          datetime.utcnow().isoformat(),
        "ml_models":          list(found),
        "ml_ready":           required.issubset(found),
        "ml_missing":         sorted(required - found),
        "openrouter_enabled": bool(settings.openrouter_api_key),
        "openrouter_model":   settings.openrouter_model,
    }


@app.get("/health/live")
async def health_live():
    return {"status": "alive", "timestamp": datetime.utcnow().isoformat()}


@app.get("/health/ready")
async def health_ready():
    checks: Dict[str, str] = {}

    try:
        await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(
                None,
                lambda: SessionLocal().execute(text("SELECT 1"))
            ),
            timeout=5,
        )
        checks["db"] = "ok"
    except Exception as e:
        checks["db"] = f"fail: {e}"

    try:
        r = await asyncio.wait_for(get_redis(), timeout=5)
        if r:
            await asyncio.wait_for(r.ping(), timeout=5)
            checks["redis"] = "ok"
        else:
            checks["redis"] = "disabled"
    except Exception as e:
        checks["redis"] = f"fail: {e}"

    if settings.openrouter_api_key:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get("https://openrouter.ai", timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    checks["openrouter"] = "ok" if resp.status < 500 else f"fail: {resp.status}"
        except Exception as e:
            checks["openrouter"] = f"fail: {e}"
    else:
        checks["openrouter"] = "not_configured"

    all_ok = all(v in ("ok", "disabled", "not_configured") for v in checks.values())
    return JSONResponse(
        status_code=200 if all_ok else 503,
        content={"status": "ready" if all_ok else "not_ready", "checks": checks},
    )


@app.get("/health/startup")
async def health_startup():
    if ML_STARTUP_COMPLETE.is_set():
        return {"status": "started", "models": list(LOADED_MODELS.keys())}
    return JSONResponse(status_code=503, content={"status": "loading"})


# -----------------------------------------------------------------
# ROUTES - Auth
# -----------------------------------------------------------------

@app.post("/api/v1/auth/register", status_code=201)
@limiter.limit("100/hour")
async def register(request: Request, req: RegisterRequest, db: Session = Depends(get_db)):
    if db.query(UserModel).filter(UserModel.email == req.email).first():
        raise HTTPException(status_code=400, detail="Email already registered")
    role = req.role or "patient"
    if role not in ("patient", "worker"):
        raise HTTPException(status_code=400, detail="role must be 'patient' or 'worker'")
    user = UserModel(
        email=_sanitize(req.email),
        name=_sanitize(req.name),
        pw_hash=hash_pw(req.password),
        age=req.age,
        gender=req.gender,
        role=role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {
        "access_token": create_token(user.id),
        "token_type":   "bearer",
        "user":         _user_response(user),
    }


@app.post("/api/v1/auth/login")
@limiter.limit("100/hour")
async def login(request: Request, req: LoginRequest, db: Session = Depends(get_db)):
    await _check_password_rate_limit(req.email)
    user = db.query(UserModel).filter(UserModel.email == req.email).first()
    if not user or not user.pw_hash or not verify_pw(req.password, user.pw_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {
        "access_token": create_token(user.id),
        "token_type":   "bearer",
        "user":         _user_response(user),
    }


# The response text is identical whether or not the email is registered --
# this is deliberate (OWASP-recommended) so the endpoint can't be used to
# discover which emails have TropiCare accounts. Everything that would
# reveal that (sending nothing for an unknown email, a different email for
# a social-only account) happens in the background, invisibly to the caller.
# expires_in_minutes is safe to include unconditionally -- it's a static
# server setting, not account-specific -- and lets the frontend show the
# real configured expiry instead of a hardcoded number that could drift
# out of sync with PASSWORD_RESET_TOKEN_EXPIRE_MINUTES.
def _generic_reset_response() -> dict:
    return {
        "message": "If an account exists for that email, we've sent a password reset link to it.",
        "expires_in_minutes": settings.password_reset_token_expire_minutes,
    }


@app.post("/api/v1/auth/forgot-password")
@limiter.limit("5/hour")
async def forgot_password(
    request: Request,
    req: ForgotPasswordRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    # Not .lower()'d: /auth/register and /auth/login both match on the
    # email exactly as typed (see req.email use there, with no case
    # normalization), so lower-casing only here would make a reset
    # silently fail to find an account whose stored email has any
    # uppercase in it. Matching that same (case-sensitive) convention
    # keeps this endpoint's lookup 1:1 with how the account was created.
    email = req.email.strip()
    await _check_reset_rate_limit(email)

    user = db.query(UserModel).filter(UserModel.email == email).first()
    if not user:
        return _generic_reset_response()

    if not user.pw_hash:
        # Social-only account (Google/Facebook/Apple) -- there's no
        # password to reset, so point them at how they actually sign in
        # instead of emailing a link that could never work.
        html, text = _no_password_account_email_bodies(user.name, user.auth_provider or "")
        background_tasks.add_task(send_email, user.email, "TropiCare password reset request", html, text)
        return _generic_reset_response()

    # A fresh request invalidates any still-unused links from earlier
    # requests, so only the most recent email a person receives can ever
    # be used.
    db.query(PasswordResetTokenModel).filter(
        PasswordResetTokenModel.user_id == user.id,
        PasswordResetTokenModel.used_at.is_(None),
    ).delete(synchronize_session=False)

    raw_token  = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    expires_at = datetime.utcnow() + timedelta(minutes=settings.password_reset_token_expire_minutes)

    db.add(PasswordResetTokenModel(user_id=user.id, token_hash=token_hash, expires_at=expires_at))
    db.commit()

    reset_link = f"{settings.frontend_url.rstrip('/')}/?reset_token={raw_token}"
    html, text = _reset_email_bodies(user.name, reset_link, settings.password_reset_token_expire_minutes)
    background_tasks.add_task(send_email, user.email, "Reset your TropiCare password", html, text)

    logger.info({"event": "password_reset_requested", "user_id": user.id})
    return _generic_reset_response()


@app.post("/api/v1/auth/reset-password")
@limiter.limit("10/hour")
async def reset_password(
    request: Request,
    req: ResetPasswordRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")

    token_hash = hashlib.sha256(req.token.encode()).hexdigest()
    token_row = db.query(PasswordResetTokenModel).filter(
        PasswordResetTokenModel.token_hash == token_hash
    ).first()

    def _invalid():
        return HTTPException(status_code=400, detail="This reset link is invalid or has already been used.")

    if not token_row or token_row.used_at is not None:
        raise _invalid()
    if token_row.expires_at < datetime.utcnow():
        raise HTTPException(status_code=400, detail="This reset link has expired. Please request a new one.")

    user = db.query(UserModel).filter(UserModel.id == token_row.user_id).first()
    if not user:
        raise _invalid()

    user.pw_hash      = hash_pw(req.new_password)
    token_row.used_at = datetime.utcnow()
    # Any other still-unused links this user requested are now stale too --
    # a password reset should only ever be completable once.
    db.query(PasswordResetTokenModel).filter(
        PasswordResetTokenModel.user_id == user.id,
        PasswordResetTokenModel.id != token_row.id,
        PasswordResetTokenModel.used_at.is_(None),
    ).delete(synchronize_session=False)
    db.commit()

    html, text = _password_changed_email_bodies(user.name)
    background_tasks.add_task(send_email, user.email, "Your TropiCare password was changed", html, text)

    logger.info({"event": "password_reset_completed", "user_id": user.id})
    return {"message": "Your password has been reset. You can now sign in with your new password."}


@app.post("/api/v1/auth/google")
@limiter.limit("100/hour")
async def auth_google(request: Request, req: GoogleAuthRequest, db: Session = Depends(get_db)):
    profile = await verify_google_access_token(req.access_token)

    if profile.get("email_verified") not in (True, "true"):
        raise HTTPException(status_code=401, detail="Your Google email address is not verified")

    email = profile.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="That Google account has no email address on file")

    user = _find_or_create_oauth_user(
        db,
        email=email,
        name=profile.get("name", ""),
        provider="google",
        oauth_sub=str(profile.get("sub", "")),
        role=req.role,
    )
    return _oauth_token_response(user)


@app.post("/api/v1/auth/facebook")
@limiter.limit("100/hour")
async def auth_facebook(request: Request, req: FacebookAuthRequest, db: Session = Depends(get_db)):
    profile = await verify_facebook_access_token(req.access_token)

    email = profile.get("email")
    if not email:
        raise HTTPException(
            status_code=400,
            detail="That Facebook account has no verified email address. Please add one on Facebook, or sign in a different way.",
        )

    user = _find_or_create_oauth_user(
        db,
        email=email,
        name=profile.get("name", ""),
        provider="facebook",
        oauth_sub=str(profile.get("id", "")),
        role=req.role,
    )
    return _oauth_token_response(user)


@app.post("/api/v1/auth/apple")
@limiter.limit("100/hour")
async def auth_apple(request: Request, req: AppleAuthRequest, db: Session = Depends(get_db)):
    payload = await verify_apple_id_token(req.id_token)

    if payload.get("email_verified") == "false":
        raise HTTPException(status_code=401, detail="Your Apple email address is not verified")

    email = payload.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="That Apple account has no email address on file")

    user = _find_or_create_oauth_user(
        db,
        email=email,
        name=req.name or "",
        provider="apple",
        oauth_sub=str(payload.get("sub", "")),
        role=req.role,
    )
    return _oauth_token_response(user)


# -----------------------------------------------------------------
# ROUTES - Patients (health worker feature)
#
# A PatientModel row represents someone a health worker (role="worker")
# is screening on the worker's behalf. It has no login of its own. Every
# endpoint below is scoped to worker_id == the authenticated worker, so a
# worker can never see, list, or act on another worker's patients.
# -----------------------------------------------------------------

@app.post("/api/v1/patients", status_code=201)
@limiter.limit("100/hour")
async def create_patient(
    request: Request,
    req: PatientCreateRequest,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    _require_worker(user_id, db)
    if not req.consent_given:
        raise HTTPException(status_code=400, detail="Patient consent is required")

    patient = PatientModel(
        worker_id=user_id,
        name=_sanitize(req.name),
        age=req.age,
        gender=req.gender,
        community=_sanitize(req.community) if req.community else None,
        consent_given=True,
        consent_timestamp=datetime.utcnow(),
    )
    db.add(patient)
    db.commit()
    db.refresh(patient)

    return {
        "id":                patient.id,
        "name":              patient.name,
        "age":               patient.age,
        "gender":            patient.gender,
        "community":         patient.community,
        "consent_given":     patient.consent_given,
        "consent_timestamp": patient.consent_timestamp.isoformat(),
        "created_at":        patient.created_at.isoformat(),
    }


@app.get("/api/v1/patients")
async def list_patients(
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    _require_worker(user_id, db)

    patients = db.query(PatientModel).filter(PatientModel.worker_id == user_id).all()

    risk_order = {"High": 0, "Medium": 1, "Low": 2, "None": 3}
    result = []
    for p in patients:
        latest = (
            db.query(DiagnosisModel)
            .filter(DiagnosisModel.patient_id == p.id)
            .order_by(DiagnosisModel.created_at.desc())
            .first()
        )
        result.append({
            "id":         p.id,
            "name":       p.name,
            "age":        p.age,
            "gender":     p.gender,
            "community":  p.community,
            "created_at": p.created_at.isoformat(),
            "latest_risk":          latest.risk if latest else None,
            "latest_assessment_at": latest.created_at.isoformat() if latest else None,
        })

    # Stable multi-key sort: most-recent-first within each risk tier, then
    # sorted highest-risk first overall (sort by least-significant key first).
    result.sort(key=lambda r: r["latest_assessment_at"] or "", reverse=True)
    result.sort(key=lambda r: risk_order.get(r["latest_risk"], 4))

    return result


@app.get("/api/v1/patients/{patient_id}")
async def get_patient(
    patient_id: int,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    _require_worker(user_id, db)

    patient = db.query(PatientModel).filter(
        PatientModel.id == patient_id,
        PatientModel.worker_id == user_id,
    ).first()
    if not patient:
        raise HTTPException(status_code=403, detail="Not authorized for this patient")

    diagnoses = (
        db.query(DiagnosisModel)
        .filter(DiagnosisModel.patient_id == patient.id)
        .order_by(DiagnosisModel.id.desc())
        .all()
    )

    return {
        "id":                patient.id,
        "name":              patient.name,
        "age":               patient.age,
        "gender":            patient.gender,
        "community":         patient.community,
        "consent_given":     patient.consent_given,
        "consent_timestamp": patient.consent_timestamp.isoformat() if patient.consent_timestamp else None,
        "created_at":        patient.created_at.isoformat(),
        "history": [
            {
                "id":           d.id,
                "disease":      d.disease,
                "risk":         d.risk,
                "confidence":   d.confidence,
                "created_at":   d.created_at.isoformat(),
                "recommendation": {
                    "home_care": d.rec_home_care,
                    "test":      d.rec_test,
                    "doctor":    d.rec_doctor,
                    "safety":    d.rec_safety,
                },
                "red_flags":       _load_json(d.rec_red_flags, []),
                "explanation":     d.ai_explanation,
                "active_symptoms": _load_json(d.active_symptoms, []),
            }
            for d in diagnoses
        ],
    }


@app.delete("/api/v1/patients/{patient_id}")
async def delete_patient(
    patient_id: int,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    """
    Permanently remove a patient a health worker registered, along with
    every assessment (DiagnosisModel) and in-progress session
    (SessionModel) recorded for them. Scoped to worker_id == the
    authenticated worker, same as every other /patients endpoint, so a
    worker can never delete another worker's patient.

    Child rows are deleted explicitly first -- patients.id is referenced
    by diagnoses.patient_id and assessment_sessions.patient_id with no
    ON DELETE CASCADE at the DB level, so deleting the parent row first
    would leave orphaned rows (or raise an FK error, depending on the
    backing DB) rather than actually clearing the patient's data.
    """
    _require_worker(user_id, db)

    patient = db.query(PatientModel).filter(
        PatientModel.id == patient_id,
        PatientModel.worker_id == user_id,
    ).first()
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")

    db.query(DiagnosisModel).filter(DiagnosisModel.patient_id == patient.id).delete(synchronize_session=False)
    db.query(SessionModel).filter(SessionModel.patient_id == patient.id).delete(synchronize_session=False)
    db.delete(patient)
    db.commit()

    await cache_delete(f"profile:{user_id}")
    return {"message": "Patient deleted"}


# -----------------------------------------------------------------
# ROUTES - Assessment
# -----------------------------------------------------------------

@app.post("/api/v1/symptoms/start", status_code=201)
@limiter.limit("5/second")
async def start_assessment(
    request: Request,
    patient_id: Optional[int] = Body(default=None, embed=True),
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    if patient_id is not None:
        worker = _require_worker(user_id, db)
        owned = db.query(PatientModel).filter(
            PatientModel.id == patient_id,
            PatientModel.worker_id == worker.id,
        ).first()
        if not owned:
            raise HTTPException(status_code=403, detail="Not authorized for this patient")

    sid     = str(uuid.uuid4())
    session = SessionModel(
        session_id=sid,
        user_id=user_id,
        patient_id=patient_id,
        answers=_dump_json({}),
        asked_questions=_dump_json([]),
        trajectory=_dump_json([]),
    )
    db.add(session)
    db.commit()
    await cache_set(
        f"session:{sid}",
        _dump_json({"answers": {}, "asked": [], "completed": False}),
        ttl=3600,
    )
    return {
        "session_id":      sid,
        "first_question":  ALL_QUESTIONS[0],
        "total_questions": 15,
    }


@app.post("/api/v1/symptoms/next")
@limiter.limit("5/second")
async def next_question(
    request: Request,
    session_id: str,
    req: AnswerRequest,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    s = db.query(SessionModel).filter(
        SessionModel.session_id == session_id,
        SessionModel.user_id == user_id,
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    if req.patient_id is not None and req.patient_id != s.patient_id:
        raise HTTPException(status_code=403, detail="patient_id does not match this session")

    answers = _load_json(s.answers, {})
    asked   = _load_json(s.asked_questions, [])

    if req.question_id not in Q_INDEX:
        raise HTTPException(status_code=400, detail=f"Unknown question_id: {req.question_id}")

    answers[req.question_id] = req.answer
    if req.question_id not in asked:
        asked.append(req.question_id)

    trajectory = _load_json(s.trajectory, [])
    snapshot   = compute_score_snapshot(answers, asked)
    top_scores = dict(sorted(snapshot.items(), key=lambda x: x[1], reverse=True)[:6])
    trajectory.append({
        "step":    len(asked),
        "symptom": req.question_id,
        "answer":  req.answer,
        "scores":  top_scores,
    })
    s.trajectory      = _dump_json(trajectory)
    s.answers         = _dump_json(answers)
    s.asked_questions = _dump_json(asked)
    db.commit()

    await cache_set(
        f"session:{session_id}",
        _dump_json({"answers": answers, "asked": asked, "completed": s.completed}),
        ttl=3600,
    )

    if len(asked) >= EXTENDED_QUESTION_CEILING:
        s.completed = True
        db.commit()
        return {"completed": True}

    if len(asked) >= BASE_QUESTION_BUDGET:
        # Base budget spent -- only a single clear leader's own remaining
        # symptoms can extend the session further (see
        # get_confirmation_extension_question's docstring). No pool/taper/
        # monopoly-cap logic applies here.
        next_q = get_confirmation_extension_question(answers, asked)
    else:
        next_q = get_next_question(answers, asked)

    if not next_q:
        s.completed = True
        db.commit()
        return {"completed": True}

    return {"completed": False, "next_question": next_q}


# -----------------------------------------------------------------
# ROUTES - Diagnosis
# -----------------------------------------------------------------

@app.post("/api/v1/diagnosis/analyze")
@limiter.limit("5/second")
async def analyze(
    request: Request,
    session_id: str,
    background_tasks: BackgroundTasks,
    patient_id: Optional[int] = Body(default=None, embed=True),
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    idem_key = request.headers.get("Idempotency-Key")
    if idem_key:
        cached_resp = await cache_get(f"idem:{idem_key}", key_type="idempotency")
        if cached_resp:
            return JSONResponse(content=json.loads(cached_resp))

    s = db.query(SessionModel).filter(
        SessionModel.session_id == session_id,
        SessionModel.user_id == user_id,
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    if patient_id is not None and patient_id != s.patient_id:
        raise HTTPException(status_code=403, detail="patient_id does not match this session")

    answers    = _load_json(s.answers, {})
    trajectory = _load_json(s.trajectory, [])
    pred       = predict_with_ml(answers)
    pred       = apply_red_flag_rules(pred, answers)

    if pred["disease"] is None:
        response_body = {
            "id":          None,
            "disease":     None,
            "confidence":  0.0,
            "risk":        "None",
            "explanation": (
                "No significant symptoms were reported. Based on your answers, "
                "there are no indicators of the conditions this system screens for."
            ),
            "all_scores":  {},
            "recommendation": {
                "home_care": "You appear to be in good health based on your responses.",
                "test":      "No tests are indicated at this time.",
                "doctor":    "See a doctor if you develop symptoms or feel unwell.",
                "safety":    "",
            },
            "red_flags":             pred.get("red_flags", []),
            "method":                pred["method"],
            "ai_used":               False,
            "confidence_trajectory": trajectory,
        }
        if idem_key:
            await cache_set(f"idem:{idem_key}", json.dumps(response_body), ttl=86400)
        return response_body

    active_syms = [k for k, v in answers.items() if v is True]

    ai_result: Optional[dict] = None
    try:
        ai_result = await asyncio.wait_for(
            call_openrouter(pred["disease"], pred["risk"], active_syms, pred["confidence"]),
            timeout=12.0,
        )
    except asyncio.TimeoutError:
        logger.warning({"event": "openrouter_timeout", "context": "analyze"})
    except Exception as e:
        logger.warning({"event": "openrouter_failed", "error": str(e)})

    rec = build_recommendation(pred["disease"], pred["risk"], ai_result)

    diag = DiagnosisModel(
        user_id               = user_id,
        session_id            = session_id,
        patient_id            = s.patient_id,
        disease               = pred["disease"],
        risk                  = pred["risk"],
        confidence            = pred["confidence"],
        answers               = _dump_json(answers),
        active_symptoms       = _dump_json(active_syms),
        rec_home_care         = rec["home_care"],
        rec_test              = rec["test"],
        rec_doctor            = rec["doctor"],
        rec_safety            = rec.get("safety", ""),
        rec_red_flags         = _dump_json(pred.get("red_flags", [])),
        ai_explanation        = rec.get("explanation", ""),
        ml_scores             = _dump_json(pred.get("all_scores", {})),
        confidence_trajectory = _dump_json(trajectory),
    )
    db.add(diag)
    db.commit()
    db.refresh(diag)

    await cache_delete(f"profile:{user_id}")

    response_body = {
        "id":          diag.id,
        "disease":     pred["disease"],
        "confidence":  pred["confidence"],
        "risk":        pred["risk"],
        "explanation": rec.get("explanation", ""),
        "all_scores":  pred.get("all_scores", {}),
        "recommendation": {
            "home_care": rec["home_care"],
            "test":      rec["test"],
            "doctor":    rec["doctor"],
            "safety":    rec.get("safety", ""),
        },
        "red_flags":             pred.get("red_flags", []),
        "method":                pred["method"],
        "ai_used":               ai_result is not None,
        "confidence_trajectory": trajectory,
    }

    if idem_key:
        await cache_set(f"idem:{idem_key}", json.dumps(response_body), ttl=86400)

    return response_body


# -----------------------------------------------------------------
# ROUTES - Clinics
#
# See the "CLINIC FINDER (server-side proxy)" section above for why this
# proxies to Geoapify's Places API rather than the frontend calling a
# public data source directly, and for the curated-fallback safety net
# used when that call itself fails.
# -----------------------------------------------------------------

@app.get("/api/v1/clinics/nearby")
@limiter.limit("20/minute")
async def clinics_nearby(
    request: Request,
    lat: float,
    lon: float,
    user_id: int = Depends(verify_token),
):
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        raise HTTPException(status_code=400, detail="Invalid coordinates")

    # Cache key bumped to v4: the underlying data source changed from
    # Overpass to Geoapify, so any entries written under the old v3
    # key/logic must never be served — they were generated by a different
    # provider with different place IDs and coverage.
    cache_key = f"clinics:elements:v4:{round(lat, 2)}:{round(lon, 2)}"
    cached = await cache_get(cache_key, key_type="clinics")

    raw_places: Optional[List[dict]] = None
    if cached:
        try:
            raw_places = json.loads(cached)
        except Exception:
            raw_places = None

    if raw_places is None:
        features = await _fetch_geoapify_features(lat, lon)
        raw_places = _extract_geoapify_places(features)
        if raw_places:
            await cache_set(cache_key, json.dumps(raw_places), ttl=CLINIC_CACHE_TTL_S)

    # Fall back to the curated list rather than dead-ending the whole
    # feature whenever the live Geoapify call itself fails (missing/invalid
    # API key, network error, non-200 response, or a genuinely empty
    # result — see _fetch_geoapify_features above). Deliberately not
    # cached under the live cache key, so the next request still tries the
    # live API first and switches back automatically the moment it works.
    used_fallback = False
    if not raw_places:
        raw_places = [
            f for f in _FALLBACK_FACILITIES
            if _haversine_km(lat, lon, f["lat"], f["lon"]) <= CLINIC_FALLBACK_MAX_DISTANCE_KM
        ]
        if raw_places:
            used_fallback = True
            CLINIC_SOURCE_ERRORS.labels(source="geoapify", reason="fallback_used").inc()
            logger.info({
                "event": "clinic_fallback_used",
                "lat": lat, "lon": lon,
                "matched_count": len(raw_places),
            })

    if not raw_places:
        raise HTTPException(
            status_code=404,
            detail="No hospitals, clinics, or pharmacies were found near this location.",
        )

    # Distance is always computed fresh against this request's exact
    # coordinates, whether the facility list came from cache, a live
    # fetch, or the fallback list, so "nearest" is never stale relative to
    # where the person actually is right now.
    ranked = _rank_places_by_distance(raw_places, lat, lon, limit=CLINIC_RESULTS_LIMIT)
    return {"places": ranked, "source": "fallback" if used_fallback else "live"}


# -----------------------------------------------------------------
# ROUTES - Patient History
# FIX: removed `request: Request` parameter — it was unused and caused
# FastAPI to bind it incorrectly on some versions. The rate-limiter
# decorator is also removed from GET history routes since they are
# already protected by JWT and do not need per-IP throttling.
# -----------------------------------------------------------------

@app.get("/api/v1/patient/history")
async def get_history(
    cursor: Optional[int] = None,
    limit: int = 20,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    limit = min(limit, 100)
    query = db.query(DiagnosisModel).filter(DiagnosisModel.user_id == user_id)
    if cursor is not None:
        query = query.filter(DiagnosisModel.id < cursor)

    rows = query.order_by(DiagnosisModel.id.desc()).limit(limit).all()

    user         = db.query(UserModel).filter(UserModel.id == user_id).first()
    patient_name = user.name if user else "Unknown"

    return [
        {
            "id":           d.id,
            "disease":      d.disease,
            "risk":         d.risk,
            "confidence":   d.confidence,
            "created_at":   d.created_at.isoformat(),
            "patient_name": patient_name,
            "recommendation": {
                "home_care": d.rec_home_care,
                "test":      d.rec_test,
                "doctor":    d.rec_doctor,
                "safety":    d.rec_safety,
            },
            "red_flags":       _load_json(d.rec_red_flags, []),
            "explanation":     d.ai_explanation,
            "active_symptoms": _load_json(d.active_symptoms, []),
        }
        for d in rows
    ]


@app.get("/api/v1/patient/history/{diag_id}")
async def get_diagnosis(
    diag_id: int,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    d = db.query(DiagnosisModel).filter(
        DiagnosisModel.id == diag_id,
        DiagnosisModel.user_id == user_id,
    ).first()
    if not d:
        raise HTTPException(status_code=404, detail="Not found")

    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    return {
        "id":              d.id,
        "disease":         d.disease,
        "risk":            d.risk,
        "confidence":      d.confidence,
        "created_at":      d.created_at.isoformat(),
        "patient_name":    user.name if user else "Unknown",
        "answers":         _load_json(d.answers, {}),
        "active_symptoms": _load_json(d.active_symptoms, []),
        "recommendation": {
            "home_care": d.rec_home_care,
            "test":      d.rec_test,
            "doctor":    d.rec_doctor,
            "safety":    d.rec_safety,
        },
        "red_flags":              _load_json(d.rec_red_flags, []),
        "explanation":            d.ai_explanation,
        "ml_scores":              _load_json(d.ml_scores, {}),
        "confidence_trajectory":  _load_json(d.confidence_trajectory, []),
    }


@app.delete("/api/v1/patient/history/{diag_id}")
async def delete_diagnosis(
    diag_id: int,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    d = db.query(DiagnosisModel).filter(
        DiagnosisModel.id == diag_id,
        DiagnosisModel.user_id == user_id,
    ).first()
    if not d:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(d)
    db.commit()
    await cache_delete(f"profile:{user_id}")
    return {"message": "Record deleted"}


# -----------------------------------------------------------------
# ROUTES - User Profile
# -----------------------------------------------------------------

@app.get("/api/v1/user/profile")
async def get_profile(
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    cache_key = f"profile:{user_id}"
    cached    = await cache_get(cache_key, key_type="profile")
    if cached:
        return json.loads(cached)

    u = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")

    count = db.query(DiagnosisModel).filter(DiagnosisModel.user_id == user_id).count()
    high  = db.query(DiagnosisModel).filter(
        DiagnosisModel.user_id == user_id,
        DiagnosisModel.risk == "High",
    ).count()

    result = {
        "id":               u.id,
        "email":            u.email,
        "name":             u.name,
        "age":              u.age,
        "gender":           u.gender,
        "role":             u.role or "patient",
        "joined_at":        u.created_at.isoformat(),
        "assessment_count": count,
        "high_risk_count":  high,
    }
    await cache_set(cache_key, json.dumps(result), ttl=300)
    return result


@app.put("/api/v1/user/profile")
async def update_profile(
    req: ProfileUpdate,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    u = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if req.name   is not None: u.name   = _sanitize(req.name)
    if req.age    is not None: u.age    = req.age
    if req.gender is not None: u.gender = req.gender
    db.commit()
    await cache_delete(f"profile:{user_id}")
    return {"id": u.id, "name": u.name, "age": u.age, "gender": u.gender}


@app.put("/api/v1/user/change-password")
async def change_password(
    req: ChangePasswordRequest,
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    u = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if not u.pw_hash or not verify_pw(req.current_password, u.pw_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
    u.pw_hash = hash_pw(req.new_password)
    db.commit()
    return {"message": "Password updated successfully"}


@app.delete("/api/v1/user/account")
async def delete_account(
    user_id: int = Depends(verify_token),
    db: Session = Depends(get_db),
):
    db.query(DiagnosisModel).filter(DiagnosisModel.user_id == user_id).delete()
    db.query(SessionModel).filter(SessionModel.user_id == user_id).delete()
    db.query(UserModel).filter(UserModel.id == user_id).delete()
    db.commit()
    await cache_delete(f"profile:{user_id}")
    return {"message": "Account deleted"}


# -----------------------------------------------------------------
# ROUTES - Admin
# -----------------------------------------------------------------

@app.get("/api/v1/admin/stats")
async def admin_stats(
    admin_id: int = Depends(verify_admin),
    db: Session = Depends(get_db),
):
    cache_key = "admin:stats"
    cached    = await cache_get(cache_key, key_type="admin_stats")
    if cached:
        return json.loads(cached)
    result = {
        "total_users":     db.query(UserModel).count(),
        "total_diagnoses": db.query(DiagnosisModel).count(),
        "high_risk":       db.query(DiagnosisModel).filter(DiagnosisModel.risk == "High").count(),
        "medium_risk":     db.query(DiagnosisModel).filter(DiagnosisModel.risk == "Medium").count(),
        "low_risk":        db.query(DiagnosisModel).filter(DiagnosisModel.risk == "Low").count(),
    }
    await cache_set(cache_key, json.dumps(result), ttl=30)
    return result


@app.get("/api/v1/admin/all-records")
async def all_records(
    admin_id: int = Depends(verify_admin),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(DiagnosisModel)
        .order_by(DiagnosisModel.created_at.desc())
        .limit(500)
        .all()
    )
    user_ids = {d.user_id for d in rows}
    users    = {
        u.id: u.name
        for u in db.query(UserModel).filter(UserModel.id.in_(user_ids)).all()
    }
    return [
        {
            "id":           d.id,
            "disease":      d.disease,
            "risk":         d.risk,
            "confidence":   d.confidence,
            "patient_name": users.get(d.user_id, "Unknown"),
            "created_at":   d.created_at.isoformat(),
        }
        for d in rows
    ]


@app.delete("/api/v1/admin/clear-database")
async def clear_database(
    admin_id: int = Depends(verify_admin),
    db: Session = Depends(get_db),
):
    deleted = db.query(DiagnosisModel).delete()
    db.query(SessionModel).delete()
    db.commit()
    await cache_delete("admin:stats")
    return {"message": f"Cleared {deleted} diagnosis records"}


@app.delete("/api/v1/admin/record/{diag_id}")
async def delete_record(
    diag_id: int,
    admin_id: int = Depends(verify_admin),
    db: Session = Depends(get_db),
):
    d = db.query(DiagnosisModel).filter(DiagnosisModel.id == diag_id).first()
    if not d:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(d)
    db.commit()
    await cache_delete("admin:stats")
    return {"message": "Record deleted"}


# -----------------------------------------------------------------
# ROUTES - Admin: Model Reload
# -----------------------------------------------------------------

@app.post("/api/v1/admin/models/reload")
async def reload_models(admin_id: int = Depends(verify_admin)):
    if not JOBLIB_AVAILABLE:
        raise HTTPException(status_code=501, detail="joblib not available")
    pkl_files = [f for f in os.listdir(MODELS_DIR) if f.endswith(".pkl")]
    if not pkl_files:
        return {"reloaded": [], "message": "No .pkl files found"}
    loop = asyncio.get_event_loop()
    for fname in pkl_files:
        await loop.run_in_executor(None, _load_single_model, fname)
    return {"reloaded": pkl_files, "models": list(LOADED_MODELS.keys())}


# -----------------------------------------------------------------
# ROUTES - Admin: Schema Migration (manual trigger)
#
# Useful if you want to re-run the column sync on demand (e.g. right after
# deploying a model change) without waiting for the next process restart.
# -----------------------------------------------------------------

@app.post("/api/v1/admin/schema/sync")
async def sync_schema(admin_id: int = Depends(verify_admin)):
    run_schema_migrations()
    inspector = inspect(engine)
    report = {}
    for model in (UserModel, SessionModel, DiagnosisModel, PatientModel, PasswordResetTokenModel):
        table = model.__table__
        try:
            cols = {c["name"] for c in inspector.get_columns(table.name)}
        except Exception:
            cols = set()
        expected = {c.name for c in table.columns}
        report[table.name] = {
            "expected": sorted(expected),
            "present":  sorted(cols),
            "missing":  sorted(expected - cols),
        }
    return {"message": "Schema sync complete", "tables": report}


# -----------------------------------------------------------------
# ENTRYPOINT
# -----------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=False,
    )
