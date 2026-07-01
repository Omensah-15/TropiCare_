/*
 * TropiCare — ClinicFinder.jsx
 * Free clinic/hospital locator using browser geolocation, OpenStreetMap (Leaflet)
 * and Overpass API. Google Maps used for directions only.
 */

import { useState, useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* ---------------- ICONS ---------------- */

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

/* ---------------- CONFIG ---------------- */

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const SEARCH_RADIUS_M = 6000;

/* ---------------- HELPERS ---------------- */

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildOverpassQuery(lat, lon, radius) {
  return `[out:json][timeout:25];
(
  node["amenity"="hospital"](around:${radius},${lat},${lon});
  way["amenity"="hospital"](around:${radius},${lat},${lon});
  node["amenity"="clinic"](around:${radius},${lat},${lon});
  way["amenity"="clinic"](around:${radius},${lat},${lon});
  node["amenity"="doctors"](around:${radius},${lat},${lon});
  node["amenity"="pharmacy"](around:${radius},${lat},${lon});
);
out center;`;
}

function extractPlaces(elements, userLat, userLon) {
  const places = elements
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;

      if (!lat || !lon) return null;

      const tags = el.tags || {};
      const name = tags.name || "Unnamed facility";

      const type =
        tags.amenity === "hospital"
          ? "Hospital"
          : tags.amenity === "clinic"
          ? "Clinic"
          : tags.amenity === "doctors"
          ? "Doctor"
          : tags.amenity === "pharmacy"
          ? "Pharmacy"
          : "Health Facility";

      return {
        id: `${el.type}/${el.id}`,
        name,
        type,
        lat,
        lon,
        distanceKm: haversineKm(userLat, userLon, lat, lon),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return places.slice(0, 15);
}

function directionsUrl(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${oLat},${oLon}&destination=${dLat},${dLon}&travelmode=driving`;
}

/* ---------------- COMPONENT ---------------- */

export default function ClinicFinder({ onClose }) {
  const [status, setStatus] = useState("locating");
  const [position, setPosition] = useState(null);
  const [clinics, setClinics] = useState([]);
  const [error, setError] = useState("");

  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const layerRef = useRef(null);

  /* ---------------- GET LOCATION ---------------- */

  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus("error");
      setError("Geolocation not supported.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        });
        setStatus("searching");
      },
      () => {
        setStatus("error");
        setError("Location permission denied.");
      }
    );
  }, []);

  /* ---------------- FETCH CLINICS ---------------- */

  useEffect(() => {
    if (status !== "searching" || !position) return;

    let cancelled = false;

    const fetchData = async () => {
      try {
        const query = buildOverpassQuery(
          position.lat,
          position.lon,
          SEARCH_RADIUS_M
        );

        const res = await fetch(OVERPASS_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: query,
        });

        const data = await res.json();
        if (cancelled) return;

        const places = extractPlaces(
          data.elements || [],
          position.lat,
          position.lon
        );

        if (!places.length) {
          setStatus("error");
          setError("No clinics found nearby.");
          return;
        }

        setClinics(places);
        setStatus("ready");
      } catch {
        if (!cancelled) {
          setStatus("error");
          setError("Network error loading clinics.");
        }
      }
    };

    fetchData();

    return () => {
      cancelled = true;
    };
  }, [status, position]);

  /* ---------------- MAP INIT ---------------- */

  useEffect(() => {
    if (status !== "ready" || !position || !mapRef.current) return;

    // create map once
    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current).setView(
        [position.lat, position.lon],
        13
      );

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap",
      }).addTo(mapInstance.current);

      layerRef.current = L.layerGroup().addTo(mapInstance.current);
    }

    // FIX: ensures proper rendering (critical for Vercel / React)
    setTimeout(() => {
      mapInstance.current?.invalidateSize();
    }, 150);

    layerRef.current.clearLayers();

    L.marker([position.lat, position.lon], { icon: USER_ICON })
      .addTo(layerRef.current)
      .bindPopup("You are here");

    clinics.forEach((c) => {
      L.marker([c.lat, c.lon])
        .addTo(layerRef.current)
        .bindPopup(c.name);
    });

    mapInstance.current.fitBounds(
      [
        [position.lat, position.lon],
        ...clinics.slice(0, 5).map((c) => [c.lat, c.lon]),
      ],
      { padding: [30, 30] }
    );
  }, [status, position, clinics]);

  const nearest = clinics[0];

  /* ---------------- UI ---------------- */

  return (
    <div className="cf-overlay" onClick={onClose}>
      <div className="cf-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cf-map" ref={mapRef} />

        <div className="cf-body">
          {status === "locating" && <p>Getting location...</p>}
          {status === "searching" && <p>Searching clinics...</p>}

          {status === "error" && <p>{error}</p>}

          {status === "ready" && nearest && (
            <a
              href={directionsUrl(
                position.lat,
                position.lon,
                nearest.lat,
                nearest.lon
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Directions to Nearest — {nearest.name}
            </a>
          )}

          {status === "ready" &&
            clinics.map((c) => (
              <div key={c.id} className="cf-item">
                <div>
                  <strong>{c.name}</strong>
                  <div>{c.distanceKm.toFixed(1)} km</div>
                </div>

                <a
                  href={directionsUrl(
                    position.lat,
                    position.lon,
                    c.lat,
                    c.lon
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Directions
                </a>
              </div>
            ))}
        </div>

        <button onClick={onClose} className="cf-close">
          ✕
        </button>
      </div>
    </div>
  );
}
