// ============================================================
// PWA-REGISTER.JS
// Registers the service worker so the site can be installed
// and can receive push notifications, without pulling in the
// chat/socket.io logic that client.js needs (that only loads
// on the /nodi.html chat page).
// ============================================================

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker
            .register("/sw.js")
            .catch(error => console.error("Service worker registration failed:", error));
    });
}