const BUILD = "__BUILD__";
const CACHE_NAME = "sofianotes-v" + BUILD;
const APP_SHELL = [
  "/",
  "/index.html",
  "/style.css?v=" + BUILD,
  "/de-words.js?v=" + BUILD,
  "/ink-recognize.js?v=" + BUILD,
  "/offline.js?v=" + BUILD,
  "/updates.js?v=" + BUILD,
  "/app.js?v=" + BUILD,
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL).catch((err) => {
        console.warn("SW precache error:", err);
      })
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        const oldKeys = keys.filter((k) => k !== CACHE_NAME);
        return Promise.all(oldKeys.map((k) => caches.delete(k))).then(() => {
          if (oldKeys.length > 0) {
            return self.clients.matchAll({ type: "window" }).then((clients) => {
              clients.forEach((c) => c.postMessage({ type: "SW_UPDATED" }));
            });
          }
        });
      }),
    ])
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isCdn(url) {
  return (
    url.hostname === "cdnjs.cloudflare.com" ||
    url.hostname === "cdn.jsdelivr.net" ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com"
  );
}

function isHtmlPath(pathname) {
  return pathname === "/" || pathname === "/index.html";
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/ws")) return;
  if (url.pathname === "/service-worker.js") return;

  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    if (url.pathname.startsWith("/api/media/")) {
      event.respondWith(
        fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
          .catch(() => caches.match(event.request))
      );
    }
    return;
  }

  if (url.origin === self.location.origin || isCdn(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request).then((hit) => {
            if (hit) return hit;
            if (isHtmlPath(url.pathname)) return caches.match("/index.html");
            return undefined;
          })
        )
    );
  }
});
