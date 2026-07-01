/*
 * TropiCare — ClinicFinder.jsx
 * Nearby clinic/hospital locator. Facility data is fetched through the
 * TropiCare backend (/api/v1/clinics/nearby), which proxies the upstream
 * map data source server-side.
 *
 * Location accuracy: a single geolocation reading can be imprecise,
 * especially on devices without GPS. Rather than trusting the first fix,
 * this samples multiple readings over a short window and keeps the most
 * accurate one. The location pin on the map is also draggable, so the
 * person can correct their exact position with certainty if the automatic
 * fix is ever off — search results update immediately from wherever the
 * pin is placed.
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
// HIGH-ACCURACY LOCATION
//
// navigator.geolocation.getCurrentPosition returns the first fix a device
// can produce, which can be a rough Wi-Fi/network estimate before a GPS
// lock settles in — particularly on first use. This instead watches for
// up to maxWaitMs, keeping the most accurate reading (lowest
// coords.accuracy, in metres) seen during that window, and returns early
// the moment a genuinely precise fix (<= targetAccuracyM) arrives.
// ─────────────────────────────────────────────
function getBestPosition({ maxWaitMs = 8000, targetAccuracyM = 30 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported on this device."));
      return;
    }

    let best = null;
    let watchId = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (best) {
        resolve(best);
      } else {
        reject(new Error("Could not get a location fix."));
      }
    };

    const timer = setTimeout(finish, maxWaitMs);

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        if (!best || accuracy < best.accuracy) {
          best = { lat: latitude, lon: longitude, accuracy };
        }
        if (accuracy <= targetAccuracyM) {
          clearTimeout(timer);
          finish();
        }
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        reject(err);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs }
    );
  });
}

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
    .cf-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border,#dde4ea);flex-shrink:0;}
    .cf-title{font-family:var(--display,serif);font-size:18px;font-weight:700;color:var(--ink,#0b1726);}
    .cf-sub{font-size:12px;color:var(--muted,#5b6b7c);margin-top:2px;}
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
    .cf-list{display:flex;flex-direction:column;gap:8px;}
    .cf-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border,#dde4ea);border-radius:14px;}
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
  const [status, setStatus] = useState("locating"); // locating | searching | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  const [position, setPosition] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [clinics, setClinics] = useState([]);

  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersLayer = useRef(null);

  useEffect(() => { injectClinicFinderStyles(); }, []);

  // ── Acquire the most accurate device location available ──
  const getLocation = useCallback(() => {
    setStatus("locating");
    setErrorMsg("");
    setClinics([]);

    getBestPosition()
      .then(({ lat, lon, accuracy: acc }) => {
        setPosition({ lat, lon });
        setAccuracy(acc);
        setStatus("searching");
      })
      .catch((geoErr) => {
        console.error("ClinicFinder: geolocation error:", geoErr.message);
        setStatus("error");
        setErrorMsg(
          geoErr.code === 1
            ? "Location access was denied. Enable location permissions in your browser settings and try again."
            : "Could not determine your location. Check your device's location settings and try again."
        );
      });
  }, []);

  useEffect(() => { getLocation(); }, [getLocation]);

  // ── Manual correction: dragging the pin re-searches from that exact spot ──
  const handleManualPosition = useCallback((lat, lon) => {
    setPosition({ lat, lon });
    setAccuracy(null); // a manually placed pin is treated as user-confirmed
    setClinics([]);
    setStatus("searching");
  }, []);

  // ── Search for clinics whenever we have a position to search from ──
  useEffect(() => {
    if (status !== "searching" || !position) return;
    let cancelled = false;

    const run = async () => {
      try {
        const places = await fetchNearbyClinics(position.lat, position.lon);
        if (cancelled) return;
        setClinics(places);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        console.error("ClinicFinder: search failed:", err.message);
        setStatus("error");
        if (err.status === 404) {
          setErrorMsg("No hospitals, clinics, or pharmacies were found within 6 km of this location.");
        } else if (err.status === 401) {
          setErrorMsg("Your session has expired. Please sign in again and retry.");
        } else {
          setErrorMsg("We couldn't load nearby clinics right now. Please check your connection and try again.");
        }
      }
    };

    run();
    return () => { cancelled = true; };
  }, [status, position]);

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
        ? `Your location · accurate to ~${Math.round(accuracy)}m<br/><em>Drag to correct if needed</em>`
        : `Your location<br/><em>Drag to correct if needed</em>`
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

    if (status === "ready" && clinics.length > 0) {
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
  }, [position, accuracy, status, clinics, handleManualPosition]);

  const nearest = clinics[0];
  const showMap = !!position;

  const retrySearch = () => {
    if (position) {
      setClinics([]);
      setStatus("searching");
    } else {
      getLocation();
    }
  };

  return (
    <div className="cf-overlay" onClick={onClose}>
      <div className="cf-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cf-head">
          <div>
            <div className="cf-title">Nearby Clinics & Hospitals</div>
            <div className="cf-sub">
              {status === "ready" ? `${clinics.length} facilities found nearby` : "Finding facilities near you"}
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
              className="cf-recenter-btn"
              onClick={getLocation}
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
              Drag the blue pin on the map to your exact location for the most accurate results.
            </div>
          </div>
        )}

        <div className="cf-body">
          {status === "locating" && (
            <div className="cf-state">
              <div className="cf-spinner" />
              <div className="cf-state-text">Getting your precise location...</div>
            </div>
          )}

          {status === "searching" && (
            <div className="cf-inline-loading">
              <div className="cf-spinner cf-spinner-sm" />
              Searching for nearby clinics...
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
        </div>
      </div>
    </div>
  );
}
