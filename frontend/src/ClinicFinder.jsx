/*
 * TropiCare — ClinicFinder.jsx
 * Nearby clinic/hospital locator. Facility data is fetched through the
 * TropiCare backend (/api/v1/clinics/nearby), which proxies the upstream
 * map data source server-side.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ─────────────────────────────────────────────
// BACKEND CONFIG
// ─────────────────────────────────────────────
const API_BASE = "https://tropicare.onrender.com/api/v1";
const TOKEN_KEY = "tc_token";

// ─────────────────────────────────────────────
// LEAFLET ICONS
// ─────────────────────────────────────────────
const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

const USER_ICON = L.divIcon({
  className: "cf-user-marker",
  html: '<div class="cf-user-dot"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

// ─────────────────────────────────────────────
// LOCATION ACQUISITION CONSTANTS
// ─────────────────────────────────────────────
const FAST_FIX_TIMEOUT_MS = 7000;        // how long we wait for the first high-accuracy fix
const FAST_FIX_MAX_AGE_MS = 5000;        // accept a recent cached fix for a fast first paint
const FALLBACK_FIX_TIMEOUT_MS = 6000;    // second attempt, network/Wi-Fi based, for devices with no GPS lock
const REFINE_WINDOW_MS = 16000;          // how long we keep listening for a better fix
const REFINE_TARGET_ACCURACY_M = 10;     // stop refining once we're this precise
const MOVE_RESEARCH_THRESHOLD_M = 35;    // only re-fetch clinics if the correction moved this far
const MAX_PLAUSIBLE_JUMP_M = 3000;       // ignore a refinement fix that teleports further than this
                                          // in one tick unless it comes with a genuinely tight accuracy —
                                          // this is what stops the pin from jumping across town on a
                                          // noisy Wi-Fi/cell reading

// ─────────────────────────────────────────────
// GEOLOCATION HELPERS
// ─────────────────────────────────────────────

/** True when the runtime can legally use the Geolocation API at all. */
function geolocationEnvironmentOk() {
  if (!navigator.geolocation) return false;
  // Browsers only expose geolocation on HTTPS (or localhost during dev).
  if (window.isSecureContext === false) return false;
  return true;
}

function getPositionOnce(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        resolve({ lat: latitude, lon: longitude, accuracy });
      },
      (err) => reject(err),
      options
    );
  });
}

/**
 * Resolves the first usable fix as fast as possible. Tries a high-accuracy
 * GPS read first (best on phones); if that fails or times out for a reason
 * other than the person denying permission, it immediately falls back to a
 * network/Wi-Fi based read, which is what most laptops and desktops rely on
 * since they have no GPS radio at all. This mirrors how Google Maps and
 * Uber degrade gracefully across device types instead of just failing.
 */
async function getFastPosition() {
  if (!geolocationEnvironmentOk()) {
    const reason = !navigator.geolocation ? "unsupported" : "insecure";
    throw Object.assign(new Error("Geolocation is not available."), { code: reason });
  }

  try {
    return await getPositionOnce({
      enableHighAccuracy: true,
      timeout: FAST_FIX_TIMEOUT_MS,
      maximumAge: FAST_FIX_MAX_AGE_MS,
    });
  } catch (err) {
    // Permission denial should surface immediately — retrying will not help.
    if (err.code === 1) throw err;

    // Any other failure (timeout, unavailable GPS radio, indoor signal loss)
    // — fall back once to a coarser, network-based fix before giving up.
    try {
      return await getPositionOnce({
        enableHighAccuracy: false,
        timeout: FALLBACK_FIX_TIMEOUT_MS,
        maximumAge: 120000,
      });
    } catch (fallbackErr) {
      throw fallbackErr.code ? fallbackErr : err;
    }
  }
}

/**
 * Starts a background watch that only reports a new fix when it is a
 * meaningful accuracy improvement over the last one (avoids jittering the
 * pin on noisy readings). Stops automatically once a precise fix is
 * reached or the time window elapses. Returns a handle with `.stop()` so
 * the caller can cancel it early (e.g. on manual drag or unmount).
 */
function startRefinement({ startAccuracy, startLat, startLon, onImprove, onDone }) {
  if (!navigator.geolocation) {
    onDone();
    return { stop: () => {} };
  }

  let best = startAccuracy;
  let lastLat = startLat;
  let lastLon = startLon;
  let finished = false;
  let watchId = null;

  const finish = () => {
    if (finished) return;
    finished = true;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    onDone();
  };

  const timer = setTimeout(finish, REFINE_WINDOW_MS);

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      if (!(accuracy > 0) || accuracy >= best - 1) return;

      // Reject readings that teleport an implausible distance in one tick
      // unless the reading itself is genuinely precise — this is what
      // keeps a stray Wi-Fi/cell estimate from yanking the pin across town.
      const jumpedM = distanceMetres(lastLat, lastLon, latitude, longitude);
      if (jumpedM > MAX_PLAUSIBLE_JUMP_M && accuracy > REFINE_TARGET_ACCURACY_M * 2) {
        return;
      }

      best = accuracy;
      lastLat = latitude;
      lastLon = longitude;
      onImprove({ lat: latitude, lon: longitude, accuracy });
      if (accuracy <= REFINE_TARGET_ACCURACY_M) {
        clearTimeout(timer);
        finish();
      }
    },
    () => {
      /* Background errors are ignored — a usable fix already exists. */
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: REFINE_WINDOW_MS }
  );

  return {
    stop: () => {
      clearTimeout(timer);
      finish();
    },
  };
}

function distanceMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Smoothly glides a Leaflet marker to a new position (ease-out cubic). */
function animateMarkerTo(marker, toLatLng, duration = 650) {
  if (!marker) return;
  const from = marker.getLatLng();
  const to = L.latLng(toLatLng);
  if (from.equals(to)) return;

  if (marker._tcAnimFrame) {
    cancelAnimationFrame(marker._tcAnimFrame);
    marker._tcAnimFrame = null;
  }

  const start = performance.now();

  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const lat = from.lat + (to.lat - from.lat) * eased;
    const lng = from.lng + (to.lng - from.lng) * eased;
    marker.setLatLng([lat, lng]);
    if (t < 1) {
      marker._tcAnimFrame = requestAnimationFrame(step);
    } else {
      marker._tcAnimFrame = null;
    }
  };

  marker._tcAnimFrame = requestAnimationFrame(step);
}

// ─────────────────────────────────────────────
// API
//
// The backend races 3 upstream mirrors with an 18s internal budget and its
// own app-wide request timeout sits at 30s, returning a 504 if that budget
// is exceeded. This client-side fetch is given a matching timeout — long
// enough to never cut off a request the backend would have finished, short
// enough to fail fast if the network itself is the problem — plus a small
// bounded retry for the specific failure modes that are transient (network
// blips, 5xx, and the backend's own 504) so a single bad mirror or a brief
// connectivity hiccup self-heals instead of surfacing as an error the
// person has to notice and tap through.
// ─────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 25000;   // stays above the backend's 18s clinic budget, below its 30s hard cutoff
const FETCH_MAX_RETRIES = 2;      // total of 3 attempts
const FETCH_RETRY_BASE_MS = 1200; // backoff: ~1.2s, then ~2.4s

function isRetryableError(error) {
  // Network failure (offline, DNS, connection reset) or our own abort-on-timeout.
  if (error.name === "AbortError" || error.name === "TypeError") return true;
  // Backend/app-wide timeout, or a transient upstream/server failure.
  if (error.status === 504 || (error.status >= 500 && error.status < 600)) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchNearbyClinicsOnce(lat, lon) {
  const token = localStorage.getItem(TOKEN_KEY);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // FIX: belt-and-suspenders cache defeat. The backend now sends
  // Cache-Control: no-store, which is correct and sufficient for
  // well-behaved browsers — but it relies on every layer between this
  // device and Render honoring that header. Mobile carrier networks in
  // particular sometimes run transparent HTTP caching proxies that key
  // purely on the request URL and ignore response cache directives
  // entirely. Appending a changing, meaningless query param makes every
  // request's URL unique, which defeats that class of cache outright
  // regardless of whether it respects Cache-Control — and explicit
  // no-cache request headers cover browsers/proxies that do inspect them.
  const cacheBuster = Date.now();
  let res;
  try {
    res = await fetch(
      `${API_BASE}/clinics/nearby?lat=${lat}&lon=${lon}&_=${cacheBuster}`,
      {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
        cache: "no-store",
        signal: controller.signal,
      }
    );
  } catch (err) {
    // AbortError (our own timeout) or a raw network TypeError both land here.
    const error = err.name === "AbortError"
      ? Object.assign(new Error("Request timed out"), { name: "AbortError" })
      : err;
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.detail || `HTTP ${res.status}`);
    error.status = res.status;
    // Surfaced only in dev tools, not to the user — lets you confirm from
    // the browser console alone which backend build actually answered,
    // without needing to open the Network tab.
    error.build = res.headers.get("X-Clinics-Build") || "unknown";
    throw error;
  }

  const data = await res.json();
  return (data.places || []).map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    address: p.address,
    lat: p.lat,
    lon: p.lon,
    distanceKm: p.distance_km,
  }));
}

/**
 * Wraps fetchNearbyClinicsOnce with bounded retry-with-backoff for
 * transient failures only. Auth errors (401), not-found (404), and other
 * 4xx responses are not retryable — retrying them would just waste time
 * before showing the same outcome — so they fail immediately on the
 * first attempt.
 */
async function fetchNearbyClinics(lat, lon, { onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
    try {
      return await fetchNearbyClinicsOnce(lat, lon);
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === FETCH_MAX_RETRIES;
      if (isLastAttempt || !isRetryableError(err)) {
        throw err;
      }
      if (onRetry) onRetry(attempt + 1);
      await sleep(FETCH_RETRY_BASE_MS * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

function directionsUrl(originLat, originLon, destLat, destLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLon}&destination=${destLat},${destLon}&travelmode=driving`;
}

// ─────────────────────────────────────────────
// SELF-CONTAINED STYLES
// ─────────────────────────────────────────────
const injectClinicFinderStyles = () => {
  if (document.getElementById("cf-styles")) return;
  const el = document.createElement("style");
  el.id = "cf-styles";
  el.textContent = `
    .cf-overlay{position:fixed;inset:0;background:rgba(11,23,38,0.55);z-index:9998;display:flex;align-items:flex-end;justify-content:center;animation:cfFade 220ms ease;}
    @media(min-width:768px){.cf-overlay{align-items:center;padding:24px;}}
    @keyframes cfFade{from{opacity:0;}to{opacity:1;}}
    .cf-sheet{background:var(--surface,#fff);width:100%;max-width:560px;max-height:92vh;border-radius:20px 20px 0 0;display:flex;flex-direction:column;overflow:hidden;animation:cfUp 300ms ease;box-shadow:0 14px 48px rgba(11,23,38,0.24);}
    @media(min-width:768px){.cf-sheet{border-radius:16px;max-height:85vh;}}
    @keyframes cfUp{from{transform:translateY(24px);opacity:0;}to{transform:none;opacity:1;}}
    .cf-head{display:flex;align-items:flex-start;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border,#dde4ea);flex-shrink:0;gap:12px;}
    .cf-title{font-family:var(--display,serif);font-size:18px;font-weight:700;color:var(--ink,#0b1726);}
    .cf-sub{font-size:12px;color:var(--muted,#5b6b7c);margin-top:2px;}
    .cf-accuracy-row{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--teal-d,#0a6b62);font-weight:700;margin-top:4px;}
    .cf-accuracy-dot{width:6px;height:6px;border-radius:50%;background:var(--teal,#0c8a7e);flex-shrink:0;animation:cfDotPulse 1.2s ease-in-out infinite;}
    @keyframes cfDotPulse{0%,100%{opacity:0.35;}50%{opacity:1;}}
    .cf-close-btn{border:none;background:var(--border-l,#eef2f5);border-radius:8px;padding:8px;cursor:pointer;display:flex;color:var(--muted,#5b6b7c);flex-shrink:0;}
    .cf-close-btn:hover{background:var(--border,#dde4ea);}
    .cf-map-wrap{position:relative;flex-shrink:0;}
    .cf-map{width:100%;height:240px;background:var(--border-l,#eef2f5);}
    .cf-recenter-btn{position:absolute;top:10px;right:10px;z-index:500;border:none;background:var(--surface,#fff);color:var(--ink-2,#1a2a3c);border-radius:8px;padding:8px;cursor:pointer;display:flex;box-shadow:0 2px 8px rgba(11,23,38,0.2);}
    .cf-recenter-btn:hover{background:var(--border-l,#eef2f5);}
    .cf-hint{display:flex;align-items:flex-start;gap:8px;padding:10px 18px;background:var(--teal-xl,#eefcfa);border-bottom:1px solid var(--border,#dde4ea);flex-shrink:0;}
    .cf-hint-text{font-size:12px;color:var(--teal-dd,#074d47);line-height:1.5;}
    .cf-body{flex:1;overflow-y:auto;padding:14px 18px 18px;}
    .cf-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px 20px;text-align:center;gap:10px;}
    .cf-state-title{font-size:15px;font-weight:700;color:var(--ink,#0b1726);}
    .cf-state-text{font-size:13px;color:var(--muted,#5b6b7c);line-height:1.55;}
    .cf-retry-btn{margin-top:6px;padding:11px 22px;border-radius:10px;border:none;font-weight:600;font-size:14px;cursor:pointer;background:linear-gradient(160deg,var(--teal,#0c8a7e) 0%,var(--teal-d,#0a6b62) 100%);color:#fff;}
    .cf-directions-btn{display:block;width:100%;text-align:center;padding:13px 18px;border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;background:linear-gradient(160deg,var(--teal,#0c8a7e) 0%,var(--teal-d,#0a6b62) 100%);color:#fff;margin-bottom:14px;box-sizing:border-box;}
    .cf-updating-banner{display:flex;align-items:center;gap:9px;padding:9px 12px;margin-bottom:12px;background:var(--teal-xl,#eefcfa);border:1px solid var(--teal-l,#bdf0ea);border-radius:10px;font-size:12px;font-weight:600;color:var(--teal-dd,#074d47);}
    .cf-list{display:flex;flex-direction:column;gap:8px;}
    .cf-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border,#dde4ea);border-radius:14px;}
    .cf-item.nearest{border-color:var(--teal,#0c8a7e);background:var(--teal-xl,#eefcfa);}
    .cf-item-icon{width:36px;height:36px;border-radius:10px;background:var(--teal-xl,#eefcfa);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--teal-d,#0a6b62);}
    .cf-item-name{font-size:13px;font-weight:700;color:var(--ink,#0b1726);display:flex;align-items:center;flex-wrap:wrap;}
    .cf-item-meta{font-size:11px;color:var(--muted,#5b6b7c);margin-top:2px;}
    .cf-item-dist{font-size:12px;font-weight:800;color:var(--teal-d,#0a6b62);white-space:nowrap;}
    .cf-item-directions{border:none;background:var(--border-l,#eef2f5);color:var(--ink-2,#1a2a3c);border-radius:8px;padding:7px 12px;font-size:11px;font-weight:700;cursor:pointer;text-decoration:none;white-space:nowrap;}
    .cf-item-directions:hover{background:var(--border,#dde4ea);}
    .cf-user-dot{position:relative;z-index:1;width:16px;height:16px;border-radius:50%;background:#2f6fed;border:3px solid #fff;box-shadow:0 0 0 2px rgba(47,111,237,0.45);cursor:grab;}
    .cf-user-marker.refining .cf-user-dot::after{content:'';position:absolute;inset:-11px;border-radius:50%;background:rgba(47,111,237,0.35);animation:cfLocatePulse 1.6s ease-out infinite;z-index:-1;}
    @keyframes cfLocatePulse{0%{transform:scale(0.4);opacity:0.8;}100%{transform:scale(2.4);opacity:0;}}
    .cf-badge-nearest{display:inline-flex;padding:2px 8px;border-radius:99px;background:var(--teal,#0c8a7e);color:#fff;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;margin-left:8px;}
    .cf-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--border,#dde4ea);border-top-color:var(--teal,#0c8a7e);animation:cfSpin 0.8s linear infinite;}
    .cf-spinner-sm{width:16px;height:16px;border-width:2px;flex-shrink:0;}
    @keyframes cfSpin{to{transform:rotate(360deg);}}
    .cf-inline-loading{display:flex;align-items:center;gap:10px;padding:16px 0;color:var(--muted,#5b6b7c);font-size:13px;}
  `;
  document.head.appendChild(el);
};

// ─────────────────────────────────────────────
// ICONS
// ─────────────────────────────────────────────
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const PinIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
  </svg>
);

const AlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="30" height="30">
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const CrosshairIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <circle cx="12" cy="12" r="7" /><line x1="12" y1="2" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="22" /><line x1="2" y1="12" x2="5" y2="12" />
    <line x1="19" y1="12" x2="22" y2="12" />
  </svg>
);

const InfoIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

const HospitalIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    <rect x="3" y="8" width="18" height="13" rx="1.5" />
    <path d="M8 21V11" /><path d="M16 21V11" />
    <path d="M12 21V8" /><path d="M9.5 4.5h5" /><path d="M12 2v5" />
    <path d="M10.5 12.5h3M12 11v3" />
  </svg>
);

const PharmacyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    <path d="M10.5 20.5a4.5 4.5 0 01-6.36-6.36l8.14-8.14a4.5 4.5 0 116.36 6.36l-3.14 3.14" />
    <line x1="9" y1="13" x2="14" y2="18" />
  </svg>
);

const DoctorIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    <path d="M6 4v5a4 4 0 008 0V4" />
    <path d="M18 8v3a6 6 0 01-12 0V8" />
    <circle cx="19" cy="6" r="2" />
    <line x1="10" y1="20" x2="14" y2="20" />
  </svg>
);

/**
 * Visual identity per facility category — icon, tint, and short label —
 * so the list reads at a glance the way Google Maps / Uber place pins do.
 * Government and private hospitals get distinct colours so users can tell
 * them apart immediately without reading the subtitle.
 */
function getFacilityStyle(type) {
  switch (type) {
    case "Government Hospital":
      return { Icon: HospitalIcon, color: "var(--blue-d, #1d54c4)", bg: "var(--blue-l, #eaf1ff)" };
    case "Private Hospital":
      return { Icon: HospitalIcon, color: "var(--purple-d, #5f3fd0)", bg: "var(--purple-l, #f1ecfe)" };
    case "Hospital":
      return { Icon: HospitalIcon, color: "var(--red-d, #c22f2f)", bg: "var(--red-l, #fdecec)" };
    case "Pharmacy":
      return { Icon: PharmacyIcon, color: "var(--green-d, #16793f)", bg: "var(--green-l, #e9f9ee)" };
    case "Doctor's Office":
      return { Icon: DoctorIcon, color: "var(--amber-d, #b9740a)", bg: "var(--amber-l, #fef3e0)" };
    case "Clinic":
    default:
      return { Icon: PinIcon, color: "var(--teal-d, #0a6b62)", bg: "var(--teal-xl, #eefcfa)" };
  }
}

// ─────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────
export default function ClinicFinder({ onClose }) {
  const [status, setStatus] = useState("locating"); // locating | searching | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  const [searchNote, setSearchNote] = useState("");
  const [position, setPosition] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [refining, setRefining] = useState(false);
  const [resultsUpdating, setResultsUpdating] = useState(false);
  const [clinics, setClinics] = useState([]);

  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const clinicLayerRef = useRef(null);
  const userMarkerRef = useRef(null);
  const accuracyCircleRef = useRef(null);
  const refineHandleRef = useRef(null);
  const lastSearchedPosRef = useRef(null);
  const skipNextAnimationRef = useRef(true);
  const statusRef = useRef(status);
  const handleManualPositionRef = useRef(() => {});

  useEffect(() => { injectClinicFinderStyles(); }, []);
  useEffect(() => { statusRef.current = status; }, [status]);

  // ── Clinic search (foreground = blocking UI, background = silent refresh) ──
  const runClinicSearch = useCallback(async (lat, lon, { background = false } = {}) => {
    lastSearchedPosRef.current = { lat, lon };

    if (background) {
      setResultsUpdating(true);
    } else {
      setStatus("searching");
      setErrorMsg("");
      setSearchNote("");
      setClinics([]);
    }

    try {
      const places = await fetchNearbyClinics(lat, lon, {
        // A transient failure (network blip, 5xx, backend 504) is being
        // retried automatically — surface that quietly instead of the
        // person staring at an unexplained delay past the usual load time.
        onRetry: (attempt) => {
          if (!background) {
            setSearchNote(`Connection is slow, retrying (attempt ${attempt + 1} of 3)...`);
          }
        },
      });
      setClinics(places);
      setStatus("ready");
      setErrorMsg("");
      setSearchNote("");
    } catch (err) {
      console.error("ClinicFinder: search failed:", err.message, "| backend build:", err.build || "n/a");
      if (!background) {
        setStatus("error");
        setSearchNote("");
        if (err.status === 404) {
          setErrorMsg("No hospitals, clinics, or pharmacies were found near this location.");
        } else if (err.status === 401) {
          setErrorMsg("Your session has expired. Please sign in again and retry.");
        } else if (err.name === "AbortError") {
          setErrorMsg("Finding clinics is taking longer than expected. Please try again.");
        } else if (err.status >= 500) {
          setErrorMsg("The clinic search service is temporarily unavailable. Please try again in a moment.");
        } else {
          setErrorMsg("We couldn't load nearby clinics right now. Please check your connection and try again.");
        }
      }
      // A background refresh triggered by GPS refinement fails silently —
      // the previously loaded results stay on screen instead of being
      // replaced with an error the person didn't ask for.
    } finally {
      if (background) setResultsUpdating(false);
    }
  }, []);

  // ── Acquire device location: fast fix first, then background refinement ──
  const getLocation = useCallback(() => {
    if (refineHandleRef.current) {
      refineHandleRef.current.stop();
      refineHandleRef.current = null;
    }

    setStatus("locating");
    setErrorMsg("");
    setClinics([]);
    setRefining(false);
    setAccuracy(null);
    skipNextAnimationRef.current = true;

    getFastPosition()
      .then(({ lat, lon, accuracy: acc }) => {
        setPosition({ lat, lon });
        setAccuracy(acc);
        runClinicSearch(lat, lon);

        // Keep refining quietly in the background so the pin settles onto
        // the person's exact position, the way Google Maps / Uber do.
        setRefining(true);
        refineHandleRef.current = startRefinement({
          startAccuracy: acc,
          startLat: lat,
          startLon: lon,
          onImprove: ({ lat: rLat, lon: rLon, accuracy: rAcc }) => {
            skipNextAnimationRef.current = false;
            setPosition({ lat: rLat, lon: rLon });
            setAccuracy(rAcc);

            const last = lastSearchedPosRef.current;
            const movedM = last ? distanceMetres(last.lat, last.lon, rLat, rLon) : Infinity;
            if (movedM > MOVE_RESEARCH_THRESHOLD_M) {
              runClinicSearch(rLat, rLon, { background: statusRef.current === "ready" });
            }
          },
          onDone: () => setRefining(false),
        });
      })
      .catch((geoErr) => {
        setRefining(false);
        setStatus("error");
        if (geoErr.code === "unsupported") {
          setErrorMsg("Location services are not supported on this device or browser.");
        } else if (geoErr.code === "insecure") {
          setErrorMsg("Location requires a secure connection. Please reload the app over HTTPS.");
        } else if (geoErr.code === 1) {
          setErrorMsg("Location access was denied. Enable location permissions for this site in your browser or device settings, then try again.");
        } else if (geoErr.code === 2) {
          setErrorMsg("Your device could not determine a location fix. Check that location services are turned on and try again.");
        } else if (geoErr.code === 3) {
          setErrorMsg("Finding your location is taking longer than expected. Check your connection and try again.");
        } else {
          setErrorMsg("Could not determine your location. Check your device's location settings and try again.");
        }
      });
  }, [runClinicSearch]);

  useEffect(() => { getLocation(); }, [getLocation]);

  // ── Manual correction: dragging the pin overrides refinement entirely ──
  const handleManualPosition = useCallback((lat, lon) => {
    if (refineHandleRef.current) {
      refineHandleRef.current.stop();
      refineHandleRef.current = null;
    }
    setRefining(false);
    skipNextAnimationRef.current = true;
    setPosition({ lat, lon });
    setAccuracy(null);
    runClinicSearch(lat, lon);
  }, [runClinicSearch]);

  useEffect(() => { handleManualPositionRef.current = handleManualPosition; }, [handleManualPosition]);

  const retrySearch = () => {
    if (position) {
      runClinicSearch(position.lat, position.lon);
    } else {
      getLocation();
    }
  };

  // ── Stop any in-flight refinement and tear down the map on unmount ──
  useEffect(() => {
    return () => {
      if (refineHandleRef.current) {
        refineHandleRef.current.stop();
        refineHandleRef.current = null;
      }
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, []);

  // ── Create the map + user marker once, then glide the marker on every
  //    subsequent position update instead of recreating it ──
  useEffect(() => {
    if (!position || !mapRef.current) return;

    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current, { zoomControl: true }).setView(
        [position.lat, position.lon], 16
      );
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(mapInstance.current);

      clinicLayerRef.current = L.layerGroup().addTo(mapInstance.current);

      const marker = L.marker([position.lat, position.lon], {
        icon: USER_ICON,
        draggable: true,
        autoPan: true,
        zIndexOffset: 1000,
      }).addTo(mapInstance.current);

      marker.on("dragend", (e) => {
        const { lat, lng } = e.target.getLatLng();
        handleManualPositionRef.current(lat, lng);
      });

      userMarkerRef.current = marker;
      setTimeout(() => mapInstance.current?.invalidateSize(), 150);
      return;
    }

    const marker = userMarkerRef.current;
    if (!marker) return;

    if (skipNextAnimationRef.current) {
      marker.setLatLng([position.lat, position.lon]);
      skipNextAnimationRef.current = false;
    } else {
      animateMarkerTo(marker, [position.lat, position.lon], 650);
      mapInstance.current.flyTo(
        [position.lat, position.lon],
        mapInstance.current.getZoom(),
        { duration: 0.65 }
      );
    }
  }, [position]);

  // ── Pulsing halo while we're still locking onto the exact position ──
  useEffect(() => {
    const el = userMarkerRef.current?.getElement?.();
    if (el) el.classList.toggle("refining", refining);
  }, [refining, position]);

  // ── Popup text reflects current accuracy / refinement state ──
  useEffect(() => {
    const marker = userMarkerRef.current;
    if (!marker || !position) return;
    const content = refining
      ? "Pinpointing your exact location…<br/><em>Drag anytime to set it manually</em>"
      : accuracy != null
      ? `Your location · accurate to ~${Math.round(accuracy)}m<br/><em>Drag to correct if needed</em>`
      : "Your location (set manually)<br/><em>Drag to adjust</em>";
    marker.bindPopup(content);
  }, [position, accuracy, refining]);

  // ── Accuracy circle tracks the marker's current precision ──
  useEffect(() => {
    if (!mapInstance.current || !position) return;
    if (accuracy && accuracy > 12) {
      const latlng = [position.lat, position.lon];
      if (accuracyCircleRef.current) {
        accuracyCircleRef.current.setLatLng(latlng);
        accuracyCircleRef.current.setRadius(accuracy);
      } else {
        accuracyCircleRef.current = L.circle(latlng, {
          radius: accuracy,
          color: "#2f6fed",
          weight: 1,
          fillColor: "#2f6fed",
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(mapInstance.current);
      }
    } else if (accuracyCircleRef.current) {
      mapInstance.current.removeLayer(accuracyCircleRef.current);
      accuracyCircleRef.current = null;
    }
  }, [position, accuracy]);

  // ── Clinic markers + bounds fit — only when the results list itself changes ──
  useEffect(() => {
    if (!mapInstance.current || !clinicLayerRef.current) return;
    clinicLayerRef.current.clearLayers();
    if (status === "ready" && clinics.length > 0 && position) {
      clinics.forEach((c, i) => {
        L.marker([c.lat, c.lon])
          .addTo(clinicLayerRef.current)
          .bindPopup(`<strong>${c.name}</strong><br/>${c.type}${i === 0 ? " · Nearest" : ""}`);
      });
      const bounds = L.latLngBounds([
        [position.lat, position.lon],
        ...clinics.slice(0, 8).map((c) => [c.lat, c.lon]),
      ]);
      mapInstance.current.fitBounds(bounds, { padding: [32, 32], animate: true, duration: 0.6 });
    }
    // Intentionally excludes `position` — refits only when the results
    // themselves change, not on every small GPS refinement tick, which
    // would otherwise cause the map to jump around as accuracy improves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, clinics]);

  const nearest = clinics[0];
  const showMap = !!position;

  return (
    <div className="cf-overlay" onClick={onClose}>
      <div className="cf-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cf-head">
          <div>
            <div className="cf-title">Nearby Clinics & Hospitals</div>
            <div className="cf-sub">
              {status === "ready"
                ? `${clinics.length} facilities found nearby`
                : status === "locating"
                ? "Finding your location"
                : status === "searching"
                ? "Finding facilities near you"
                : ""}
            </div>
            {position && status !== "error" && (refining || accuracy != null) && (
              <div className="cf-accuracy-row">
                {refining && <span className="cf-accuracy-dot" />}
                {refining
                  ? "Refining your exact location…"
                  : accuracy != null
                  ? `Accurate to ~${Math.round(accuracy)}m`
                  : "Location set manually"}
              </div>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="cf-close-btn">
            <CloseIcon />
          </button>
        </div>

        {showMap && (
          <div className="cf-map-wrap">
            <div className="cf-map" ref={mapRef} />
            <button
              className="cf-recenter-btn"
              onClick={getLocation}
              aria-label="Refresh my current device location"
              title="Refresh my current device location"
            >
              <CrosshairIcon />
            </button>
          </div>
        )}

        {showMap && (
          <div className="cf-hint">
            <InfoIcon />
            <div className="cf-hint-text">
              {refining
                ? "We're locking onto your exact position — the pin settles automatically."
                : "Drag the blue pin on the map to your exact location for the most accurate results."}
            </div>
          </div>
        )}

        <div className="cf-body">
          {status === "locating" && (
            <div className="cf-state">
              <div className="cf-spinner" />
              <div className="cf-state-text">Getting your location...</div>
            </div>
          )}

          {status === "searching" && (
            <div className="cf-inline-loading">
              <div className="cf-spinner cf-spinner-sm" />
              {searchNote || "Searching for nearby clinics..."}
            </div>
          )}

          {status === "error" && (
            <div className="cf-state">
              <AlertIcon />
              <div className="cf-state-title">Could not find clinics</div>
              <div className="cf-state-text">{errorMsg}</div>
              <button className="cf-retry-btn" onClick={retrySearch}>Try Again</button>
            </div>
          )}

          {status === "ready" && (
            <>
              {resultsUpdating && (
                <div className="cf-updating-banner">
                  <div className="cf-spinner cf-spinner-sm" />
                  Updating results for your exact location…
                </div>
              )}

              {nearest && (
                <a
                  href={directionsUrl(position.lat, position.lon, nearest.lat, nearest.lon)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="cf-directions-btn"
                >
                  Directions to Nearest — {nearest.name} ({nearest.distanceKm.toFixed(1)} km)
                </a>
              )}
              <div className="cf-list">
                {clinics.map((c, i) => {
                  const { Icon: TypeIcon, color, bg } = getFacilityStyle(c.type);
                  return (
                  <div key={c.id} className={`cf-item${i === 0 ? " nearest" : ""}`}>
                    <div className="cf-item-icon" style={{ background: bg, color }}><TypeIcon /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="cf-item-name">
                        {c.name}
                        {i === 0 && <span className="cf-badge-nearest">Nearest</span>}
                      </div>
                      <div className="cf-item-meta">
                        {c.type}{c.address ? ` · ${c.address}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                      <div className="cf-item-dist">{c.distanceKm.toFixed(1)} km</div>
                      <a
                        href={directionsUrl(position.lat, position.lon, c.lat, c.lon)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cf-item-directions"
                      >
                        Directions
                      </a>
                    </div>
                  </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
