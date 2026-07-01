/*
 * TropiCare — ClinicFinder.jsx
 * Nearby clinic/hospital locator. Facility data is fetched through the
 * TropiCare backend (/api/v1/clinics/nearby), which proxies the upstream
 * map data source server-side.
 *
 * LOCATION STRATEGY
 * A device's very first location reading is often a coarse network/Wi-Fi
 * estimate, with a precise GPS fix arriving a few seconds later. Rather
 * than waiting for "the best of several samples" before showing anything
 * (slow, and still no better than one fix if GPS never improves), this
 * shows the first reading immediately and keeps listening in the
 * background: any later reading that is at least as accurate as the one
 * currently in use silently replaces it and the search re-runs — the pin
 * and results snap to the precise location the moment GPS locks in, with
 * no action needed. A reading that is *less* accurate than what's already
 * trusted is always discarded, so the location only ever gets better,
 * never worse. Dragging the pin remains available as a manual override,
 * but is a safety net rather than the primary mechanism.
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
// LOCATION TUNING
// ─────────────────────────────────────────────
const GOOD_ACCURACY_M = 30;      // stop refining once a fix this precise (or better) arrives
const REFINE_WINDOW_MS = 20000;  // stop listening for improvements after this long, regardless
const SEARCH_DEBOUNCE_MS = 450;  // avoid firing a search on every micro-update while GPS settles

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
// API
// ─────────────────────────────────────────────
async function fetchNearbyClinics(lat, lon) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(
    `${API_BASE}/clinics/nearby?lat=${lat}&lon=${lon}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.detail || `HTTP ${res.status}`);
    error.status = res.status;
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

function directionsUrl(originLat, originLon, destLat, destLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLon}&destination=${destLat},${destLon}&travelmode=driving`;
}

function formatAccuracy(m) {
  if (m == null) return "";
  if (m < 1000) return `±${Math.round(m)}m`;
  return `±${(m / 1000).toFixed(1)}km`;
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
    @media(min-width:768px){.cf-sheet{border-radius:16px;max-height:88vh;}}
    @keyframes cfUp{from{transform:translateY(24px);opacity:0;}to{transform:none;opacity:1;}}
    .cf-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border,#dde4ea);flex-shrink:0;gap:12px;}
    .cf-title-wrap{min-width:0;}
    .cf-title{font-family:var(--display,serif);font-size:18px;font-weight:700;color:var(--ink,#0b1726);}
    .cf-sub-row{display:flex;align-items:center;gap:8px;margin-top:3px;flex-wrap:wrap;}
    .cf-sub{font-size:12px;color:var(--muted,#5b6b7c);}
    .cf-accuracy-pill{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--teal-xl,#eefcfa);color:var(--teal-d,#0a6b62);white-space:nowrap;}
    .cf-refining-pill{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--blue-l,#eaf1ff);color:var(--blue-d,#1d54c4);white-space:nowrap;}
    .cf-pulse-dot{width:6px;height:6px;border-radius:50%;background:var(--blue,#2f6fed);animation:cfPulse 1.2s ease-in-out infinite;flex-shrink:0;}
    @keyframes cfPulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.35;transform:scale(0.7);}}
    .cf-close-btn{border:none;background:var(--border-l,#eef2f5);border-radius:8px;padding:8px;cursor:pointer;display:flex;color:var(--muted,#5b6b7c);flex-shrink:0;}
    .cf-close-btn:hover{background:var(--border,#dde4ea);}
    .cf-map-wrap{position:relative;flex-shrink:0;}
    .cf-map{width:100%;height:230px;background:var(--border-l,#eef2f5);}
    @media(min-width:768px){.cf-map{height:280px;}}
    .cf-recenter-btn{position:absolute;top:10px;right:10px;z-index:500;border:none;background:var(--surface,#fff);color:var(--ink-2,#1a2a3c);border-radius:10px;padding:9px;cursor:pointer;display:flex;box-shadow:0 2px 10px rgba(11,23,38,0.22);transition:background 150ms ease,transform 150ms ease;}
    .cf-recenter-btn:hover{background:var(--border-l,#eef2f5);}
    .cf-recenter-btn:active{transform:scale(0.92);}
    .cf-recenter-btn.spinning svg{animation:cfSpin 1s linear infinite;}
    .cf-hint{display:flex;align-items:flex-start;gap:8px;padding:10px 18px;background:var(--teal-xl,#eefcfa);border-bottom:1px solid var(--border,#dde4ea);flex-shrink:0;}
    .cf-hint-text{font-size:12px;color:var(--teal-dd,#074d47);line-height:1.5;}
    .cf-body{flex:1;overflow-y:auto;padding:14px 18px 18px;}
    .cf-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px 20px;text-align:center;gap:10px;}
    .cf-state-title{font-size:15px;font-weight:700;color:var(--ink,#0b1726);}
    .cf-state-text{font-size:13px;color:var(--muted,#5b6b7c);line-height:1.55;}
    .cf-retry-btn{margin-top:6px;padding:11px 22px;border-radius:10px;border:none;font-weight:600;font-size:14px;cursor:pointer;background:linear-gradient(160deg,var(--teal,#0c8a7e) 0%,var(--teal-d,#0a6b62) 100%);color:#fff;}
    .cf-directions-btn{display:block;width:100%;text-align:center;padding:13px 18px;border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;background:linear-gradient(160deg,var(--teal,#0c8a7e) 0%,var(--teal-d,#0a6b62) 100%);color:#fff;margin-bottom:14px;box-sizing:border-box;transition:box-shadow 150ms ease,transform 150ms ease;}
    .cf-directions-btn:hover{box-shadow:0 6px 18px rgba(12,138,126,0.3);transform:translateY(-1px);}
    .cf-updating-pill{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted,#5b6b7c);margin-bottom:10px;padding:8px 12px;background:var(--border-l,#eef2f5);border-radius:10px;}
    .cf-list{display:flex;flex-direction:column;gap:8px;}
    .cf-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border,#dde4ea);border-radius:14px;transition:box-shadow 150ms ease;}
    .cf-item:hover{box-shadow:0 2px 10px rgba(11,23,38,0.08);}
    .cf-item.nearest{border-color:var(--teal,#0c8a7e);background:var(--teal-xl,#eefcfa);}
    .cf-item-icon{width:36px;height:36px;border-radius:10px;background:var(--teal-xl,#eefcfa);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--teal-d,#0a6b62);}
    .cf-item-name{font-size:13px;font-weight:700;color:var(--ink,#0b1726);display:flex;align-items:center;flex-wrap:wrap;}
    .cf-item-meta{font-size:11px;color:var(--muted,#5b6b7c);margin-top:2px;}
    .cf-item-dist{font-size:12px;font-weight:800;color:var(--teal-d,#0a6b62);white-space:nowrap;}
    .cf-item-directions{border:none;background:var(--border-l,#eef2f5);color:var(--ink-2,#1a2a3c);border-radius:8px;padding:7px 12px;font-size:11px;font-weight:700;cursor:pointer;text-decoration:none;white-space:nowrap;}
    .cf-item-directions:hover{background:var(--border,#dde4ea);}
    .cf-user-dot{width:16px;height:16px;border-radius:50%;background:#2f6fed;border:3px solid #fff;box-shadow:0 0 0 2px rgba(47,111,237,0.45);cursor:grab;}
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

// ─────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────
export default function ClinicFinder({ onClose }) {
  // Location state
  const [phase, setPhase] = useState("locating"); // locating | ready | location-error
  const [position, setPosition] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [refining, setRefining] = useState(false);
  const [locationErrorMsg, setLocationErrorMsg] = useState("");

  // Clinic search state (independent of location phase, so a background
  // location refinement never blanks out results already on screen)
  const [clinics, setClinics] = useState([]);
  const [loadingClinics, setLoadingClinics] = useState(false);
  const [clinicErrorMsg, setClinicErrorMsg] = useState("");

  const watchIdRef = useRef(null);
  const refineTimerRef = useRef(null);
  const searchDebounceRef = useRef(null);
  const bestAccuracyRef = useRef(Infinity);
  const mountedRef = useRef(true);

  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersLayer = useRef(null);

  useEffect(() => { injectClinicFinderStyles(); }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const stopWatch = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (refineTimerRef.current) {
      clearTimeout(refineTimerRef.current);
      refineTimerRef.current = null;
    }
  }, []);

  // ── Clinic search, used for the initial fix, background refinements,
  //    manual pin drags, and explicit retries ──
  const searchClinicsAt = useCallback(async (lat, lon) => {
    setLoadingClinics(true);
    setClinicErrorMsg("");
    try {
      const places = await fetchNearbyClinics(lat, lon);
      if (!mountedRef.current) return;
      setClinics(places);
    } catch (err) {
      if (!mountedRef.current) return;
      console.error("ClinicFinder: search failed:", err.message);
      if (err.status === 404) {
        setClinics([]);
        setClinicErrorMsg("No hospitals, clinics, or pharmacies were found within 6 km of this location.");
      } else if (err.status === 401) {
        setClinicErrorMsg("Your session has expired. Please sign in again and retry.");
      } else {
        setClinicErrorMsg("We couldn't load nearby clinics right now. Please check your connection and try again.");
      }
    } finally {
      if (mountedRef.current) setLoadingClinics(false);
    }
  }, []);

  const scheduleSearch = useCallback((lat, lon) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => searchClinicsAt(lat, lon), SEARCH_DEBOUNCE_MS);
  }, [searchClinicsAt]);

  // ── Location acquisition: shows the first fix immediately, then keeps
  //    listening in the background and only ever replaces the position
  //    with a reading that is at least as accurate as the one in use ──
  const startLocating = useCallback(() => {
    if (!navigator.geolocation) {
      setPhase("location-error");
      setLocationErrorMsg("Your browser does not support location services.");
      return;
    }

    stopWatch();

    const hadPositionAlready = position != null;
    bestAccuracyRef.current = hadPositionAlready ? (accuracy ?? Infinity) : Infinity;

    if (!hadPositionAlready) {
      setPhase("locating");
      setLocationErrorMsg("");
    }
    setRefining(true);

    let receivedAcceptedFix = hadPositionAlready;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (!mountedRef.current) return;
        const { latitude, longitude, accuracy: acc } = pos.coords;

        if (acc <= bestAccuracyRef.current) {
          bestAccuracyRef.current = acc;
          receivedAcceptedFix = true;
          setPosition({ lat: latitude, lon: longitude });
          setAccuracy(acc);
          setPhase("ready");
          scheduleSearch(latitude, longitude);
        }

        if (acc <= GOOD_ACCURACY_M) {
          setRefining(false);
          stopWatch();
        }
      },
      (err) => {
        if (!mountedRef.current) return;
        console.error("ClinicFinder: geolocation error:", err.message);
        setRefining(false);
        if (!receivedAcceptedFix) {
          setPhase("location-error");
          setLocationErrorMsg(
            err.code === 1
              ? "Location access was denied. Enable location permissions in your browser settings and try again."
              : "Could not determine your location. Check your device's location settings and try again."
          );
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: REFINE_WINDOW_MS }
    );

    refineTimerRef.current = setTimeout(() => {
      setRefining(false);
      stopWatch();
    }, REFINE_WINDOW_MS);
  }, [position, accuracy, stopWatch, scheduleSearch]);

  // Run once on mount
  useEffect(() => {
    startLocating();
    return () => {
      stopWatch();
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Manual correction: dragging the pin is authoritative and searches
  //    immediately, no debounce ──
  const handleManualPosition = useCallback((lat, lon) => {
    stopWatch();
    setRefining(false);
    bestAccuracyRef.current = 0;
    setPosition({ lat, lon });
    setAccuracy(0);
    setPhase("ready");
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchClinicsAt(lat, lon);
  }, [stopWatch, searchClinicsAt]);

  const retryClinicSearch = useCallback(() => {
    if (position) searchClinicsAt(position.lat, position.lon);
  }, [position, searchClinicsAt]);

  // ── Map lifecycle: create once, destroy on unmount only ──
  useEffect(() => {
    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, []);

  // ── Render/update markers whenever position, accuracy, or results change ──
  useEffect(() => {
    if (!position || !mapRef.current) return;

    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current, { zoomControl: true }).setView(
        [position.lat, position.lon], 15
      );
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(mapInstance.current);
      markersLayer.current = L.layerGroup().addTo(mapInstance.current);
    }

    setTimeout(() => mapInstance.current?.invalidateSize(), 150);

    markersLayer.current.clearLayers();

    const userMarker = L.marker([position.lat, position.lon], {
      icon: USER_ICON,
      draggable: true,
      autoPan: true,
    }).addTo(markersLayer.current);

    userMarker.bindPopup(
      accuracy
        ? `Your location · accurate to ${formatAccuracy(accuracy)}<br/><em>Drag to correct if needed</em>`
        : `Your location (set manually)<br/><em>Drag to adjust</em>`
    );

    userMarker.on("dragend", (e) => {
      const { lat, lng } = e.target.getLatLng();
      handleManualPosition(lat, lng);
    });

    if (accuracy && accuracy > 15) {
      L.circle([position.lat, position.lon], {
        radius: accuracy,
        color: "#2f6fed",
        weight: 1,
        fillColor: "#2f6fed",
        fillOpacity: 0.08,
      }).addTo(markersLayer.current);
    }

    if (clinics.length > 0) {
      clinics.forEach((c, i) => {
        L.marker([c.lat, c.lon])
          .addTo(markersLayer.current)
          .bindPopup(`<strong>${c.name}</strong><br/>${c.type}${i === 0 ? " · Nearest" : ""}`);
      });
      const bounds = L.latLngBounds([
        [position.lat, position.lon],
        ...clinics.slice(0, 8).map((c) => [c.lat, c.lon]),
      ]);
      mapInstance.current.fitBounds(bounds, { padding: [32, 32] });
    } else {
      mapInstance.current.setView([position.lat, position.lon], mapInstance.current.getZoom() || 15);
    }
  }, [position, accuracy, clinics, handleManualPosition]);

  const nearest = clinics[0];
  const showMap = phase === "ready" && !!position;
  const hasResults = clinics.length > 0;

  return (
    <div className="cf-overlay" onClick={onClose}>
      <div className="cf-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cf-head">
          <div className="cf-title-wrap">
            <div className="cf-title">Nearby Clinics & Hospitals</div>
            <div className="cf-sub-row">
              <span className="cf-sub">
                {hasResults ? `${clinics.length} facilities found` : "Finding facilities near you"}
              </span>
              {phase === "ready" && accuracy != null && accuracy > 0 && !refining && (
                <span className="cf-accuracy-pill">{formatAccuracy(accuracy)}</span>
              )}
              {refining && (
                <span className="cf-refining-pill">
                  <span className="cf-pulse-dot" />
                  Refining GPS
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="cf-close-btn">
            <CloseIcon />
          </button>
        </div>

        {showMap && (
          <div className="cf-map-wrap">
            <div className="cf-map" ref={mapRef} />
            <button
              className={`cf-recenter-btn${refining ? " spinning" : ""}`}
              onClick={startLocating}
              aria-label="Use my current device location"
              title="Use my current device location"
            >
              <CrosshairIcon />
            </button>
          </div>
        )}

        {showMap && (
          <div className="cf-hint">
            <InfoIcon />
            <div className="cf-hint-text">
              Your location updates automatically as GPS improves. Drag the blue pin if it's ever off.
            </div>
          </div>
        )}

        <div className="cf-body">
          {phase === "locating" && (
            <div className="cf-state">
              <div className="cf-spinner" />
              <div className="cf-state-text">Getting your location...</div>
            </div>
          )}

          {phase === "location-error" && (
            <div className="cf-state">
              <AlertIcon />
              <div className="cf-state-title">Could not get your location</div>
              <div className="cf-state-text">{locationErrorMsg}</div>
              <button className="cf-retry-btn" onClick={startLocating}>Try Again</button>
            </div>
          )}

          {phase === "ready" && (
            <>
              {loadingClinics && !hasResults && !clinicErrorMsg && (
                <div className="cf-inline-loading">
                  <div className="cf-spinner cf-spinner-sm" />
                  Searching for nearby clinics...
                </div>
              )}

              {clinicErrorMsg && !hasResults && (
                <div className="cf-state">
                  <AlertIcon />
                  <div className="cf-state-title">Could not find clinics</div>
                  <div className="cf-state-text">{clinicErrorMsg}</div>
                  <button className="cf-retry-btn" onClick={retryClinicSearch}>Try Again</button>
                </div>
              )}

              {hasResults && (
                <>
                  {loadingClinics && (
                    <div className="cf-updating-pill">
                      <div className="cf-spinner cf-spinner-sm" />
                      Updating with your refined location...
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
                    {clinics.map((c, i) => (
                      <div key={c.id} className={`cf-item${i === 0 ? " nearest" : ""}`}>
                        <div className="cf-item-icon"><PinIcon /></div>
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
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
