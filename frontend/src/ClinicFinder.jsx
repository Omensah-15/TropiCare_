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
        tags.amenity === "hospital"
          ? "Hospital"
          : tags.amenity === "clinic"
          ? "Clinic"
          : tags.amenity === "doctors"
          ? "Doctor's Office"
          : tags.amenity === "pharmacy" || tags.healthcare === "pharmacy"
          ? "Pharmacy"
          : "Health Facility";

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
    .cf-overlay{position:fixed;inset:0;background:rgba(11,23,38,0.55);z-index:9998;display:flex;align-items:flex-end;justify-content:center;}
    .cf-sheet{background:var(--surface);width:100%;max-width:560px;max-height:92vh;border-radius:20px 20px 0 0;display:flex;flex-direction:column;overflow:hidden;}
    .cf-map{width:100%;height:220px;}
    .cf-body{flex:1;overflow-y:auto;padding:14px 18px;}
    .cf-item{display:flex;gap:12px;padding:12px;border:1px solid var(--border);border-radius:12px;}
    .cf-item.nearest{border-color:var(--teal);}
    .cf-user-dot{width:14px;height:14px;border-radius:50%;background:#2f6fed;border:3px solid #fff;}
  `;

  document.head.appendChild(el);
};

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const PinIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

export default function ClinicFinder({ onClose }) {
  const [status, setStatus] = useState("locating");
  const [errorMsg, setErrorMsg] = useState("");
  const [position, setPosition] = useState(null);
  const [clinics, setClinics] = useState([]);

  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersLayer = useRef(null);

  useEffect(() => {
    injectClinicFinderStyles();
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus("error");
      setErrorMsg("Geolocation not supported.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setStatus("searching");
      },
      () => {
        setStatus("error");
        setErrorMsg("Location permission denied.");
      }
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

        const data = await res.json();
        if (cancelled) return;

        const places = extractPlaces(data.elements || [], position.lat, position.lon);

        if (!places.length) {
          setStatus("error");
          setErrorMsg("No clinics found nearby.");
          return;
        }

        setClinics(places);
        setStatus("ready");
      } catch {
        setStatus("error");
        setErrorMsg("Network error fetching clinics.");
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [status, position]);

  useEffect(() => {
    if (status !== "ready" || !position || !mapRef.current) return;

    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current).setView([position.lat, position.lon], 13);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(
        mapInstance.current
      );

      markersLayer.current = L.layerGroup().addTo(mapInstance.current);
    }

    markersLayer.current.clearLayers();

    L.marker([position.lat, position.lon], { icon: USER_ICON }).addTo(markersLayer.current);

    clinics.forEach((c, i) => {
      L.marker([c.lat, c.lon])
        .addTo(markersLayer.current)
        .bindPopup(`${c.name}${i === 0 ? " (Nearest)" : ""}`);
    });
  }, [status, position, clinics]);

  const nearest = clinics[0];

  return (
    <div className="cf-overlay" onClick={onClose}>
      <div className="cf-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cf-map" ref={mapRef} />

        <div className="cf-body">
          {status === "ready" && nearest && (
            <a
              href={directionsUrl(position.lat, position.lon, nearest.lat, nearest.lon)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Directions to Nearest — {nearest.name}
            </a>
          )}

          {clinics.map((c, i) => (
            <div key={c.id} className={`cf-item ${i === 0 ? "nearest" : ""}`}>
              <PinIcon />
              <div>
                {c.name}
                <div>{c.distanceKm.toFixed(1)} km</div>
              </div>

              <a
                href={directionsUrl(position.lat, position.lon, c.lat, c.lon)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Directions
              </a>
            </div>
          ))}
        </div>

        <button onClick={onClose} className="cf-close">
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
