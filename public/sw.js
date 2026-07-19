const CACHE = "relaydesk-static-v6";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request, { cache: "no-store" }).catch(() => new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>RelayDesk</title><style>body{font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f2;color:#171916}.card{max-width:320px;padding:28px}button{border:0;border-radius:14px;padding:12px 18px;background:#171916;color:white;font:inherit}</style><div class=card><h2>连接暂时不可用</h2><p>检查网络后再试一次。</p><button onclick=location.reload()>重新连接</button></div>",
      { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
    )));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && url.origin === self.location.origin && url.pathname !== "/sw.js") {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
