/* Unstuck service worker.
   - Code (index.html, app.js, config.js, manifest): NETWORK-FIRST, cache as offline fallback.
     So a fix — or Supabase keys added to config.js later — reaches installed users on their next online open
     without anyone remembering to bump a version string.
   - Icons and cross-origin assets (fonts, supabase-js): cache-first / stale-while-revalidate.
   - Supabase API calls: never touched.
   Bump CACHE anyway when you ship, so stale entries from old shells get evicted. */
const CACHE = "unstuck-v5";
const SHELL = [
  "./", "./index.html", "./app.js", "./config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-192.png", "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png", "./icons/favicon-32.png"
];
const NETWORK_FIRST = /\/(index\.html|app\.js|config\.js|manifest\.webmanifest)?$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== CACHE + "-ext").map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Tapping a timer-end notification brings the app back to the front (or opens it).
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});

const put = (cacheName, req, res) => { if (res && res.ok) caches.open(cacheName).then(c => c.put(req, res.clone())); return res; };

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co") || url.hostname.endsWith("supabase.in")) return;

  if (url.origin === self.location.origin) {
    if (req.mode === "navigate" || NETWORK_FIRST.test(url.pathname)) {
      e.respondWith(
        fetch(req).then(res => put(CACHE, req, res))
          .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined)))
      );
    } else {
      e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => put(CACHE, req, res))));
    }
    return;
  }

  // Cross-origin (fonts, supabase-js CDN): stale-while-revalidate, only storing OK responses.
  e.respondWith(
    caches.open(CACHE + "-ext").then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => put(CACHE + "-ext", req, res)).catch(() => hit);
      return hit || net;
    })
  );
});
