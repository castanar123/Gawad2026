const CACHE_NAME = "gawad-parangal-pwa-v2";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/lspu-event-strip.png",
  "/lspu-brand-source.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);

    try {
      const response = await fetch(new Request("/", { cache: "reload" }));
      const html = await response.clone().text();
      await cache.put("/", response);
      const assetUrls = Array.from(html.matchAll(/(?:src|href)=["']([^"']+)["']/g))
        .map((match) => new URL(match[1], self.location.origin))
        .filter((url) => url.origin === self.location.origin && (url.pathname.startsWith("/_next/") || url.pathname.startsWith("/assets/")))
        .map((url) => url.pathname + url.search);
      await Promise.allSettled([...new Set(assetUrls)].map((url) => cache.add(url)));
    } catch {
      // The explicit app shell above remains available if asset discovery fails.
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        await cache.put("/", response.clone());
        return response;
      } catch {
        return (await caches.match(request)) || (await caches.match("/"));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") void self.skipWaiting();
});
