// TropiCare service worker
//
// Kept deliberately minimal: it only exists so the app qualifies as an
// installable PWA (Chrome/PWABuilder/TWA require a registered service
// worker with a fetch handler; without one, "Add to Home Screen" on
// Android falls back to a plain bookmark instead of a real installable
// app, and TWA packaging is refused outright).
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
