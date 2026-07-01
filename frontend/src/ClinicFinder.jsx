/*
 * TropiCare — ClinicFinder.jsx
 * Free clinic/hospital locator using browser geolocation, OpenStreetMap
 * (Leaflet) tiles, and the free Overpass API for facility data.
 * Directions are handled via Google Maps deep links — no paid routing API.
 */

import { useState, useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

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

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const SEARCH_RADIUS_M = 6000;

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

const injectClinicFinderStyles = () => {
  if (document.getElementById("cf-styles")) return;
  const el = document.createElement("style");
  el.id = "cf-styles";
  el.textContent = `
    .cf-overlay{position:fixed;inset:0;background:rgba(11,23,38,0.55);z-index:9998;display:flex;align-items:flex-end;justify-content:center;animation:cfFade var(--t-med) var(--ease);}
    @media(min-width:768px){.cf-overlay{align-items:center;padding:24px;}}
    @keyframes cfFade{from{opacity:0;}to{opacity:1;}}
    .cf-sheet{background:var(--surface);width:100%;max-width:560px;max-height:92vh;border-radius:20px 20px 0 0;display:flex;flex-direction:column;overflow:hidden;animation:cfUp var(--t-slow) var(--ease);}
    @media(min-width:768px){.cf-sheet{border-radius:var(--radius-l);max-height:85vh;}}
    @keyframes cfUp{from{transform:translateY(24px);opacity:0;}to{transform:none;opacity:1;}}
    .cf-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border);flex-shrink:0;}
    .cf-title{font-family:var(--display);font-size:18px;font-weight:700;color:var(--ink);}
    .cf-sub{font-size:12px;color:var(--muted);margin-top:2px;}
    .cf-map{width:100%;height:220px;flex-shrink:0;background:var(--border-l);}
    .cf-body{flex:1;overflow-y:auto;padding:14px 18px 18px;}
    .cf-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px 20px;text-align:center;gap:10px;}
    .cf-list{display:flex;flex-direction:column;gap:8px;}
    .cf-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius);}
    .cf-item.nearest{border-color:var(--teal);background:var(--teal-xl);}
    .cf-item-icon{width:36px;height:36px;border-radius:10px;background:var(--teal-xl);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--teal-d);}
    .cf-item-name{font-size:13px;font-weight:700;color:var(--ink);display:flex;align-items:center;}
    .cf-item-meta{font-size:11px;color:var(--muted);margin-top:2px;}
    .cf-item-dist{font-size:12px;font-weight:800;color:var(--teal-d);white-space:nowrap;}
    .cf-user-dot{width:14px;height:14px;border-radius:50%;background:#2f6fed;border:3px solid #fff;box-shadow:0 0 0 2px rgba(47,111,237,0.4);}
    .cf-badge-nearest{display:inline-flex;padding:2px 8px;border-radius:99px;background:var(--teal);color:#fff;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;margin-left:8px;}
  `;
  document.head.appendChild(el);
};

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

export default function ClinicFinder({ onClose }) {
  const [status, setStatus] = useState("locating"); // locating | searching | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  const [position, setPosition] = useState(null);
  const [clinics, setClinics] = useState([]);

  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersLayer = useRef(null);

  useEffect(() => { injectClinicFinderStyles(); }, []);

  useEffect(() => {
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
      () => {
        setStatus("error");
        setErrorMsg("Location access was denied. Enable location permissions and try again.");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }, []);

  useEffect(() => {
    if (status !== "searching" || !position) return;
    let cancelled = false;

    const run = async () => {
      try {
        const query = buildOverpassQuery(position.lat, position.lon, SEARCH_RADIUS_M);
        const res = await fetch(OVERPASS_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: query,
        });
        if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const places = extractPlaces(data.elements || [], position.lat, position.lon);
        if (places.length === 0) {
          setStatus("error");
          setErrorMsg("No clinics or hospitals were found near your location.");
          return;
        }
        setClinics(places);
        setStatus("ready");
      } catch {
        if (cancelled) return;
        setStatus("error");
        setErrorMsg("Could not reach the clinic directory. Check your connection and try again.");
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
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ border: "none", background: "var(--border-l)", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", color: "var(--muted)" }}
          >
            <CloseIcon />
          </button>
        </div>

        {status === "ready" && <div className="cf-map" ref={mapRef} />}

        <div className="cf-body">
          {(status === "locating" || status === "searching") && (
            <div className="cf-state">
              <div className="t-subtitle">
                {status === "locating" ? "Getting your location..." : "Searching for nearby clinics..."}
              </div>
            </div>
          )}

          {status === "error" && (
            <div className="cf-state">
              <div className="t-title">Could not find clinics</div>
              <div className="t-subtitle">{errorMsg}</div>
              <button className="btn btn-primary mt-3" onClick={() => { setStatus("locating"); setErrorMsg(""); }}>
                Try Again
              </button>
            </div>
          )}

          {status === "ready" && (
            <>
              {nearest && (
                
                  href={directionsUrl(position.lat, position.lon, nearest.lat, nearest.lon)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary btn-full mb-3"
                  style={{ textDecoration: "none" }}
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
                      
                        href={directionsUrl(position.lat, position.lon, c.lat, c.lon)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-secondary btn-sm"
                        style={{ textDecoration: "none" }}
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
