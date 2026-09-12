// ============================================================
// SERVICE WORKER
// Only job: receive push events while the app isn't open (tab
// closed, phone locked, browser backgrounded) and turn them
// into a real OS-level notification, then route a tap on that
// notification back into the app to the right place.
// ============================================================

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
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