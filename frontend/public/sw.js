// TropiCare service worker: offline shell caching + Web Push.
//
// Compiled by vite-plugin-pwa's "injectManifest" strategy (see
// vite.config.js), which replaces self.__WB_MANIFEST below with the real
// list of hashed files this build produced, generated fresh on every build.

import { precache, matchPrecache, cleanupOutdatedCaches } from "workbox-precaching";

// precache() only, not precacheAndRoute(): the latter also registers its
// own 'fetch' listener, which can race the one below and throw
// "respondWith already called" on navigation. precache() just fills the
// cache; the listener below is the only thing that ever responds.
precache(self.__WB_MANIFEST);

// Must match App.jsx's API_BASE -- used by pushsubscriptionchange below.
const API_BASE = "https://tropicare.onrender.com/api/v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(cleanupOutdatedCaches().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never intercept API calls -- diagnostic/session data must always be fresh.
  if (request.method !== "GET" || new URL(request.url).pathname.startsWith("/api/")) {
    return;
  }

  // Navigations: network-first, precached shell as the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => matchPrecache("index.html")));
    return;
  }

  // Everything else this build produced: cache-first from the precache above.
  event.respondWith(
    (async () => (await matchPrecache(request)) || fetch(request))()
  );
});

// ── PUSH ─────────────────────────────────────────────────────────
// Payload shape { title, body, url } comes from main.py's _send_web_push().
self.addEventListener("push", (event) => {
  let data = { title: "TropiCare Health Alert", body: "New health update available.", url: "/" };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = {
        title: parsed.title || data.title,
        body:  parsed.body  || data.body,
        url:   parsed.url   || data.url,
      };
    } catch (e) {
      try {
        data.body = event.data.text() || data.body;
      } catch (_) {}
    }
  }

  const options = {
    body: data.body,
    icon: "/icons/icon-192.png",
    // Android/Chrome render this as a monochrome silhouette (alpha
    // channel only) -- must be white-on-transparent, not the color icon.
    badge: "/icons/badge-96.png",
    data: { url: data.url },
    tag: "tropicare-outbreak-news",
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// ── NOTIFICATION CLICK ───────────────────────────────────────────
// Focuses an existing tab and navigates it; opens a new one only if none exists.
self.addEventListener("notificationclick", (event) => {
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) return client.navigate(targetUrl).catch(() => {});
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// ── PUSH SUBSCRIPTION CHANGE ─────────────────────────────────────
// Fires when the browser/push service rotates a subscription on its own.
// Re-subscribes and re-registers with the backend so alerts don't silently
// stop; the /push/subscribe endpoint upserts, so this is safe even if it
// races a foreground subscribe from Settings.

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keyRes = await fetch(`${API_BASE}/push/public-key`);
        if (!keyRes.ok) return;
        const { publicKey } = await keyRes.json();

        const newSubscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });

        const token = await getStoredToken();
        if (!token) return;

        const subJson = newSubscription.toJSON();
        await fetch(`${API_BASE}/push/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }),
        });
      } catch (e) {
        // Best-effort -- Settings' own status check will catch the mismatch later.
      }
    })()
  );
});

// Service workers can't touch localStorage directly -- ask an open client.
async function getStoredToken() {
  const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (allClients.length === 0) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => resolve(null), 1500);
    channel.port1.onmessage = (e) => {
      clearTimeout(timeout);
      resolve(e.data || null);
    };
    allClients[0].postMessage({ type: "TC_GET_TOKEN" }, [channel.port2]);
  });
}
