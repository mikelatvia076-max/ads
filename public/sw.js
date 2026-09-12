// ============================================================
// SERVICE WORKER
// Two jobs:
// 1) Receive push events while the app isn't open (tab closed,
//    phone locked, browser backgrounded) and turn them into a
//    real OS-level notification, then route a tap on that
//    notification back into the app to the right place.
// 2) Cache core static assets so the app can still open (with
//    a "you're offline" fallback for anything not cached) when
//    there's no network connection. Live data - chat messages,
//    socket.io, and /api/ routes - always go to the network,
//    never the cache, since that content changes constantly.
// ============================================================

const CACHE_NAME = "campus-hub-cache-v1";

// The core shell of the app - enough to open the homepage and
// the chat page even with no network. Anything else gets
// cached the first time it's actually requested (see fetch
// handler below).
const CORE_ASSETS = [
    "/",
    "/index.html",
    "/nodi.html",
    "/style.css",
    "/load.css",
    "/nodi.css",
    "/app.js",
    "/client.js",
    "/manifest.json",
    "/icon-192.png",
    "/icon-512.png"
];

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

    // Page navigations: try the network first so users get the
    // latest content, but fall back to the cached shell if
    // they're offline instead of showing a browser error page.
    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    return response;
                })
                .catch(() => caches.match(request).then((cached) => cached || caches.match("/index.html")))
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