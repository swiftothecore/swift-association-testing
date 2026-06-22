/* Service worker for Swift To The Song Association (static, GitHub Pages).
 *
 * Strategy:
 *  - same-origin → NETWORK-FIRST (always latest when online; fall back to cache
 *    offline, and to the cached index.html for navigations). This deliberately
 *    avoids the "my deploy isn't showing up" stale-code trap — no need to bump
 *    CACHE on every change; bump it only to evict stale precached entries.
 *  - cross-origin (Google Fonts) → CACHE-FIRST (offline fonts; they ~never change).
 *
 * Paths are relative so the worker works under the project subpath
 * (…github.io/swift-association-testing/).
 */
const CACHE = "stta-v5";
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "js/app.js",
  "js/util.js",
  "js/config.js",
  "js/bracelet.js",
  "js/storage.js",
  "songs.json",
  "words.json",
  "icons/favicon.svg",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // network-first, fall back to cache (and to index.html for navigations).
    // `cache: "reload"` makes the SW's own fetch BYPASS the browser HTTP cache —
    // without it, GitHub Pages' max-age means fetch() can return a stale file and
    // "network-first" silently behaves like "HTTP-cache-first" after a deploy.
    e.respondWith(
      fetch(req, { cache: "reload" })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))
        )
    );
  } else {
    // cross-origin (fonts): cache-first, revalidate in the background
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
              return res;
            })
            .catch(() => hit)
      )
    );
  }
});
