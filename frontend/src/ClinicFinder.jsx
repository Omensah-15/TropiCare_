/*
 * TropiCare — ClinicFinder.jsx
 * Free clinic/hospital locator using browser geolocation, OpenStreetMap
 * (Leaflet) tiles, and the free Overpass API for facility data.
 * Directions are handled via Google Maps deep links — no paid routing API.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

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
// CONFIG
//
// Multiple independent map-data sources are queried in parallel and the
// first successful response wins. This avoids the failure mode where a
// single slow source is tried, times out, and only then does a second
// source get attempted — which multiplies the total wait time and the
// chance of failure. Querying all sources at once bounds the worst case
// to a single timeout window instead of one per source.
// ─────────────────────────────────────────────
const DATA_SOURCES = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];
const SEARCH_RADIUS_M = 6000;
const REQUEST_TIMEOUT_MS = 20000;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildOverpassQuery(lat, lon, radius) {
  return `[out:json][timeout:25];(
    node["amenity"="hospital"](around:${radius},${lat},${lon});
    way["amenity"="hospital"](around:${radius},${lat},${lon});
    node["amenity"="clinic"](around:${radius},${lat},${lon});
    way["amenity"="clinic"](around:${radius},${lat},${lon});
    node["amenity"="doctors"](around:${radius},${lat},${lon});
    node["amenity"="pharmacy"](around:${radius},${lat},${lon});
    node["healthcare"="pharmacy"](around:${radius},${lat},${lon});
  );out center 40;`;
}

function extractPlaces(elements, userLat, userLon) {
  const places = elements
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) return null;
      const tags = el.tags || {};
      const name = tags.name || tags["name:en"] || "Unnamed facility";
      const type =
        tags.amenity === "hospital" ? "Hospital" :
        tags.amenity === "clinic"   ? "Clinic"   :
        tags.amenity === "doctors"  ? "Doctor's Office" :
        (tags.amenity === "pharmacy" || tags.healthcare === "pharmacy") ? "Pharmacy" :
        "Health Facility";
      const address = [tags["addr:street"], tags["addr:city"] || tags["addr:suburb"]]
        .filter(Boolean)
        .join(", ");
      return {
        id: `${el.type}/${el.id}`,
        name,
        type,
        address,
        lat,
        lon,
        distanceKm: haversineKm(userLat, userLon, lat, lon),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const seen = new Set();
  const unique = [];
  for (const p of places) {
    const key = `${p.name}-${p.lat.toFixed(3)}-${p.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique.slice(0, 15);
}

function directionsUrl(originLat, originLon, destLat, destLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLon}&destination=${destLat},${destLon}&travelmode=driving`;
}

/*
 * Queries a single data source and either resolves with its elements or
 * rejects with a descriptive error. Used as the building block for the
 * parallel race across all configured sources below.
 */
async function queryDataSource(source, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${source}?data=${encodeURIComponent(query)}`;
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`${source} responded with HTTP ${res.status}`);
    }

    const data = await res.json();
    const elements = data.elements || [];
    if (elements.length === 0) {
      // A source can return a valid empty result for a genuinely sparse
      // area; treat this as a soft failure so the race keeps waiting on
      // the remaining sources rather than resolving with nothing.
      throw new Error(`${source} returned no elements`);
    }
    return elements;
  } catch (err) {
    clearTimeout(timer);
    const reason =
      err?.name === "AbortError"
        ? `${source} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : err.message || String(err);
    console.error("ClinicFinder: data source failed:", reason);
    throw new Error(reason);
  }
}

/*
 * Races all configured data sources in parallel and returns the elements
 * from whichever responds first with usable data. This bounds the total
 * wait time to a single timeout window rather than one per source, and
 * means a single slow or unreachable source no longer blocks the search.
 */
async function fetchClinics(lat, lon) {
  const query = buildOverpassQuery(lat, lon, SEARCH_RADIUS_M);
  const attempts = DATA_SOURCES.map((source) => queryDataSource(source, query));

  try {
    return await Promise.any(attempts);
  } catch (aggregateErr) {
    const reasons = (aggregateErr.errors || []).map((e) => e.message).join(" | ");
    console.error("ClinicFinder: all data sources failed:", reasons);
    throw new Error("All data sources failed");
  }
}

// ─────────────────────────────────────────────
// SELF-CONTAINED STYLES
//
// This component is mounted as a full-screen overlay outside the normal
// page flow, so it injects its own stylesheet rather than depending on
// class names defined in App.jsx's tc-styles block.
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
    .cf-map{width:100%;height:220px;flex-shrink:0;background:var(--border-l,#eef2f5);}
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
    .cf-user-dot{width:14px;height:14px;border-radius:50%;background:#2f6fed;border:3px solid #fff;box-shadow:0 0 0 2px rgba(47,111,237,0.4);}
    .cf-badge-nearest{display:inline-flex;padding:2px 8px;border-radius:99px;background:var(--teal,#0c8a7e);color:#fff;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;margin-left:8px;}
    .cf-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--border,#dde4ea);border-top-color:var(--teal,#0c8a7e);animation:cfSpin 0.8s linear infinite;}
    @keyframes cfSpin{to{transform:rotate(360deg);}}
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

// ─────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────
export default function ClinicFinder({ onClose }) {
  const [status, setStatus] = useState("locating"); // locating | searching | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  const [position, setPosition] = useState(null);
  const [clinics, setClinics] = useState([]);

  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersLayer = useRef(null);

  useEffect(() => { injectClinicFinderStyles(); }, []);

  const getLocation = useCallback(() => {
    setStatus("locating");
    setErrorMsg("");

    if (!navigator.geolocation) {
      setStatus("error");
      setErrorMsg("Your browser does not support location services.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setStatus("searching");
      },
      (geoErr) => {
        console.error("ClinicFinder: geolocation error:", geoErr.message);
        setStatus("error");
        setErrorMsg(
          geoErr.code === 1
            ? "Location access was denied. Enable location permissions in your browser settings and try again."
            : "Could not determine your location. Check your device's location settings and try again."
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }, []);

  useEffect(() => { getLocation(); }, [getLocation]);

  useEffect(() => {
    if (status !== "searching" || !position) return;
    let cancelled = false;

    const attemptSearch = async () => {
      const elements = await fetchClinics(position.lat, position.lon);
      const places = extractPlaces(elements, position.lat, position.lon);
      if (places.length === 0) {
        throw new Error("No facilities in results after filtering");
      }
      return places;
    };

    const run = async () => {
      try {
        const places = await attemptSearch();
        if (cancelled) return;
        setClinics(places);
        setStatus("ready");
      } catch (firstErr) {
        // One silent retry before surfacing anything to the person — this
        // absorbs the common case of a single transient hiccup so it
        // never has to become a visible error at all.
        console.error("ClinicFinder: first attempt failed, retrying:", firstErr.message);
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 1200));
        if (cancelled) return;
        try {
          const places = await attemptSearch();
          if (cancelled) return;
          setClinics(places);
          setStatus("ready");
        } catch (secondErr) {
          if (cancelled) return;
          console.error("ClinicFinder: retry also failed:", secondErr.message);
          setStatus("error");
          setErrorMsg(
            "We couldn't load nearby clinics right now. Please check your internet connection and try again."
          );
        }
      }
    };

    run();
    return () => { cancelled = true; };
  }, [status, position]);

  useEffect(() => {
    if (status !== "ready" || !position || !mapRef.current) return;

    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current, { zoomControl: true }).setView(
        [position.lat, position.lon], 13
      );
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(mapInstance.current);
      markersLayer.current = L.layerGroup().addTo(mapInstance.current);
    }

    setTimeout(() => mapInstance.current?.invalidateSize(), 150);

    markersLayer.current.clearLayers();

    L.marker([position.lat, position.lon], { icon: USER_ICON })
      .addTo(markersLayer.current)
      .bindPopup("Your location");

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

    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, [status, position, clinics]);

  const nearest = clinics[0];

  const retry = () => {
    setClinics([]);
    setPosition(null);
    getLocation();
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

        {status === "ready" && <div className="cf-map" ref={mapRef} />}

        <div className="cf-body">
          {(status === "locating" || status === "searching") && (
            <div className="cf-state">
              <div className="cf-spinner" />
              <div className="cf-state-text">
                {status === "locating" ? "Getting your location..." : "Searching for nearby clinics..."}
              </div>
            </div>
          )}

          {status === "error" && (
            <div className="cf-state">
              <AlertIcon />
              <div className="cf-state-title">Could not find clinics</div>
              <div className="cf-state-text">{errorMsg}</div>
              <button className="cf-retry-btn" onClick={retry}>Try Again</button>
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
