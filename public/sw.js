// ============================================================
// SERVICE WORKER
// Two jobs:
// 1) Receive push events while the app isn't open (tab closed,
//    phone locked, browser backgrounded) and turn them into a
//    real OS-level notification, then route a tap on that
//    notification back into the app to the right place.
// 2) Pre-cache core static assets purely for faster repeat
//    loads while online. Page loads (navigations) are NOT
//    served from cache when offline - the app is meant to
//    require a connection, so offline shows a blocking "you're
//    offline" screen instead of a stale cached page. Live data -
//    chat messages, socket.io, and /api/ routes - always go to
//    the network, never the cache, since that content changes
//    constantly.
// ============================================================

const CACHE_NAME = "campus-hub-cache-v1";

// Static assets worth pre-caching for speed. Deliberately does
// NOT include index.html/nodi.html - those are navigation
// documents, and this service worker never serves a cached page
// as an offline fallback (see the "navigate" branch below), so
// pre-caching them would just be dead weight.
const CORE_ASSETS = [
    "/style.css",
    "/load.css",
    "/nodi.css",
    "/app.js",
    "/client.js",
    "/manifest.json",
    "/icon-192.png",
    "/icon-512.png"
];

// Minimal "you can't use this without internet" page, built
// inline so it never depends on a network request or a cached
// file that could itself go stale.
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>You're offline</title>
<style>
  html, body {
      margin: 0;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  }
  body {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      background: linear-gradient(135deg, #063b8f, #0b5ed7 35%, #087f5b 70%, #7c3aed);
      color: #ffffff;
  }
  .offline-box { max-width: 380px; }
  .offline-icon { font-size: 46px; margin-bottom: 14px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  p { font-size: 14px; opacity: 0.9; line-height: 1.5; margin: 0 0 22px; }
  button {
      padding: 12px 26px;
      border: none;
      border-radius: 50px;
      background: #f2a900;
      color: #063b8f;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
  }
</style>
</head>
<body>
  <div class="offline-box">
      <div class="offline-icon">&#128225;</div>
      <h1>No internet connection</h1>
      <p>This app needs an internet connection to open. Reconnect and try again.</p>
      <button onclick="location.reload()">Retry</button>
  </div>
</body>
</html>`;

self.addEventListener("install", (event) => {
    self.skipWaiting();

    event.waitUntil(
        caches
            .open(CACHE_NAME)
            .then((cache) => cache.addAll(CORE_ASSETS))
            .catch((error) => console.error("Pre-cache failed:", error))
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            // drop any old cache versions from a previous deploy
            caches.keys().then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== CACHE_NAME)
                        .map((key) => caches.delete(key))
                )
            )
        ])
    );
});

self.addEventListener("fetch", (event) => {

    const { request } = event;

    // Only ever cache GET requests for our own origin. Never touch
    // socket.io's own requests or /api/ calls - that's live data
    // (chat, presence, AI responses) that must always be fresh.
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith("/socket.io/")) return;
    if (url.pathname.startsWith("/api/")) return;
    if (url.pathname.startsWith("/uploads/")) return;

    // Page navigations: always go to the network. If that fails
    // (offline), show the blocking offline screen instead of a
    // cached page - the app deliberately doesn't work offline.
    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request).catch(() =>
                new Response(OFFLINE_HTML, {
                    status: 200,
                    headers: { "Content-Type": "text/html; charset=UTF-8" }
                })
            )
        );
        return;
    }

    // Everything else (css, js, images, fonts): cache-first, and
    // quietly update the cache in the background from the network.
    event.respondWith(
        caches.match(request).then((cached) => {

            const networkFetch = fetch(request)
                .then((response) => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => cached);

            return cached || networkFetch;
        })
    );
});

self.addEventListener("push", (event) => {

    if (!event.data) return;

    let data;
    try {
        data = event.data.json();
    } catch (error) {
        data = { title: "Site Chat", body: event.data.text() };
    }

    const isCall = data.type === "call";

    const title = data.title || "Site Chat";

    const options = {
        body: data.body || "",
        icon: data.icon || "/icon-192.png",
        badge: "/icon-192.png",
        data,
        // a call should feel like a phone ringing, not a normal ping:
        // keep it on screen and vibrate in a ring-like pattern until
        // the person actually does something with it
        requireInteraction: isCall,
        vibrate: isCall ? [400, 200, 400, 200, 400] : [150],
        tag: isCall ? `call-${data.fromId || ""}` : `chat-${data.chatId || ""}`,
        renotify: isCall,
        actions: isCall
            ? [
                { action: "answer", title: "Answer" },
                { action: "decline", title: "Decline" }
            ]
            : []
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {

    const data = event.notification.data || {};
    event.notification.close();

    // "Decline" just dismisses the ring locally - it does not need to
    // open the app. (The call still times out server-side for the
    // caller after the normal ring window if nothing else answers it.)
    if (event.action === "decline") return;

    // where tapping this notification should land once the app is open
    let target = "/";
    if (data.type === "call" && data.fromId) {
        target = `/?answerCall=${encodeURIComponent(data.fromId)}`;
    } else if (data.type === "message" && data.chatId) {
        target = `/?openChat=${encodeURIComponent(data.chatId)}`;
    }

    event.waitUntil(
        self.clients
            .matchAll({ type: "window", includeUncontrolled: true })
            .then((clientList) => {

                // if the app is already open in some tab, just focus it
                // and tell it where to go instead of opening a new one
                for (const client of clientList) {
                    if ("focus" in client) {
                        client.postMessage({ type: "notification-click", data });
                        return client.focus();
                    }
                }

                return self.clients.openWindow(target);
            })
    );
});