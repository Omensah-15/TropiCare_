// TropiCare service worker
//
// Two responsibilities:
//   1. PWA installability shell caching (unchanged from before).
//   2. Web Push handling — receiving a push event from the browser's
//      push service and turning it into a visible OS notification, then
//      routing a tap on that notification back into the app.
//
// It does NOT precache the Vite build's hashed JS/CSS bundles -- those
// filenames change on every deploy, so a hardcoded precache list would
// go stale and serve outdated code. Vite's own long-lived cache headers
// already handle those efficiently. This worker only caches the app
// shell entry points needed to open the app while offline, and it
// never touches API calls, so diagnostic/session data is always fetched
// fresh and is never served stale from a cache.

const CACHE_NAME = "tropicare-shell-v1";
const SHELL_URLS = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

// Must match App.jsx's API_BASE -- used only by the pushsubscriptionchange
// handler below to re-register a rotated subscription with the backend
// without requiring the app to be open.
const API_BASE = "https://tropicare.onrender.com/api/v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SHELL_URLS).catch(() => {
        // Best-effort: if one shell asset 404s (e.g. icons not deployed
        // yet), don't fail the whole install.
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never intercept API calls -- always hit the network so diagnostic
  // sessions, auth, and clinic data are never served stale or offline
  // when they shouldn't be. Adjust this prefix if the API is proxied
  // under a different path.
  if (request.method !== "GET" || new URL(request.url).pathname.startsWith("/api/")) {
    return;
  }

  // Navigations (loading the app itself): try the network first so
  // users always get the latest deploy, falling back to the cached
  // shell only when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/"))
    );
    return;
  }

  // Static shell assets (icons, manifest): cache-first, network fallback.
  if (SHELL_URLS.includes(new URL(request.url).pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
  }
});

// -----------------------------------------------------------------
// PUSH -- receiving a Web Push message
//
// The backend's _send_web_push() (main.py) sends a JSON payload of the
// shape { title, body, url } via webpush(). This is the ONLY place that
// payload is consumed: no title/body defaults are invented here beyond a
// safe fallback for a malformed or empty push (some push services allow
// pushes with no body at all).
// -----------------------------------------------------------------

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
      // Not valid JSON -- fall back to treating it as plain text for the
      // body rather than dropping the notification entirely.
      try {
        data.body = event.data.text() || data.body;
      } catch (_) {
        // Leave the default fallback in place.
      }
    }
  }

  const options = {
    body: data.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url },
    tag: "tropicare-outbreak-news",
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// -----------------------------------------------------------------
// NOTIFICATION CLICK -- routes a tap back into the app.
//
// If a TropiCare tab/window is already open, focuses it and navigates
// it to the article URL rather than opening a duplicate window. Only
// opens a new window when none exists.
// -----------------------------------------------------------------

self.addEventListener("notificationclick", (event) => {
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) {
            return client.navigate(targetUrl).catch(() => {});
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// -----------------------------------------------------------------
// PUSH SUBSCRIPTION CHANGE -- fires when the browser/push service
// invalidates and rotates a subscription on its own (expiry, browser
// key rotation, etc.), independent of the user ever touching the
// Settings toggle. Without handling this, the account's stored
// PushSubscriptionModel row (main.py) goes stale silently and the
// person stops receiving alerts with no visible sign why. Re-subscribes
// with a fresh applicationServerKey fetched from the backend's
// unauthenticated /push/public-key endpoint, then re-registers it —
// upserted by endpoint, so this is safe even if it races a foreground
// subscribe from Settings.
// -----------------------------------------------------------------

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
        if (!token) return; // no signed-in session to attribute this to

        const subJson = newSubscription.toJSON();
        await fetch(`${API_BASE}/push/subscribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }),
        });
      } catch (e) {
        // Best-effort only -- the next time the app is opened in the
        // foreground, Settings' own status check (App.jsx) will detect
        // the mismatch and let the user re-enable manually.
      }
    })()
  );
});

// Service workers have no direct access to localStorage. The auth token
// is read from an open client's storage via postMessage if one exists;
// if the app isn't open at all when this fires, there is nothing to
// authenticate the re-subscription with, and it is skipped (safe no-op
// -- see the comment above).
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
