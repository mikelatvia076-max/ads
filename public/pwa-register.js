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
//
// Also keeps an already-installed copy of the app updated (by
// reloading once a new service worker takes over) and blocks
// the screen whenever the device has no internet connection.
// ============================================================

if ("serviceWorker" in navigator) {

    navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {

            // Check for a new sw.js whenever the app is brought
            // back to the foreground, so a copy that's been open
            // for a while still notices a new deploy instead of
            // waiting on the browser's own (much longer) check
            // cycle.
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") {
                    registration.update().catch(() => {});
                }
            });

        })
        .catch(error => console.error("Service worker registration failed:", error));

    // Once a new service worker takes control (because it called
    // skipWaiting()), reload this tab so it ends up running the
    // new version end-to-end instead of the old page paired with
    // a new worker. Guarded so this can only fire once per tab
    // even if control changes more than once.
    let hasReloadedForUpdate = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (hasReloadedForUpdate) return;
        hasReloadedForUpdate = true;
        window.location.reload();
    });

}

// ============================================================
// OFFLINE BLOCK
// Covers the whole screen whenever there's no network, so the
// app can't be used offline even if it was already open when
// the connection dropped (the service worker's navigate handler
// only catches fresh page loads, not an already-open tab).
// ============================================================

(function () {

    function buildOfflineOverlay() {

        const overlay = document.createElement("div");
        overlay.id = "pwaOfflineOverlay";
        overlay.className = "hidden";

        overlay.innerHTML =
            '<div class="pwa-offline-box">' +
                '<div class="pwa-offline-icon">&#128225;</div>' +
                '<h1>No internet connection</h1>' +
                '<p>This app needs an internet connection. Reconnect and try again.</p>' +
                '<button id="pwaOfflineRetryBtn" type="button">Retry</button>' +
            '</div>';

        const style = document.createElement("style");
        style.textContent =
            '#pwaOfflineOverlay {' +
                'position: fixed; inset: 0; z-index: 2000000;' +
                'display: flex; align-items: center; justify-content: center;' +
                'padding: 24px; text-align: center;' +
                'background: linear-gradient(135deg, #063b8f, #0b5ed7 35%, #087f5b 70%, #7c3aed);' +
                'color: #ffffff;' +
            '}' +
            '#pwaOfflineOverlay.hidden { display: none; }' +
            '.pwa-offline-box { max-width: 380px; }' +
            '.pwa-offline-icon { font-size: 46px; margin-bottom: 14px; }' +
            '#pwaOfflineOverlay h1 { font-size: 20px; margin: 0 0 10px; }' +
            '#pwaOfflineOverlay p { font-size: 14px; opacity: 0.9; line-height: 1.5; margin: 0 0 22px; }' +
            '#pwaOfflineRetryBtn {' +
                'padding: 12px 26px; border: none; border-radius: 50px;' +
                'background: #f2a900; color: #063b8f; font-weight: 700;' +
                'font-size: 14px; cursor: pointer;' +
            '}';

        document.head.appendChild(style);
        document.body.appendChild(overlay);

        document.getElementById("pwaOfflineRetryBtn").addEventListener("click", () => {
            window.location.reload();
        });

        return overlay;
    }

    function initOfflineGuard() {

        const overlay = buildOfflineOverlay();

        function refresh() {
            if (navigator.onLine) {
                overlay.classList.add("hidden");
            } else {
                overlay.classList.remove("hidden");
            }
        }

        window.addEventListener("online", refresh);
        window.addEventListener("offline", refresh);

        refresh();
    }

    if (document.body) {
        initOfflineGuard();
    } else {
        document.addEventListener("DOMContentLoaded", initOfflineGuard);
    }

})();