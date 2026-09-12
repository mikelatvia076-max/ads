// ============================================================
// PWA-REGISTER.JS
// Registers the service worker so the site can be installed
// and can receive push notifications, without pulling in the
// chat/socket.io logic that client.js needs (that only loads
// on the /nodi.html chat page).
//
// Registers immediately (not on window "load") so scanners
// like PWABuilder, which don't always wait for the load event
// to fire, can detect it right away.
// ============================================================

if ("serviceWorker" in navigator) {
    navigator.serviceWorker
        .register("/sw.js")
        .catch(error => console.error("Service worker registration failed:", error));
}