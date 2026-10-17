/*
=========================================================
LATEST CAMPUS VIDEOS
=========================================================

Shows a scrolling row of recent, university-related YouTube
videos from  GET /api/university-videos  (see server.js).

Self-mounting - no other script needs to call it:
  - index.html:     fills <div id="homeVideos">
  - category.html:  inserts the row above the article list on
                    the University Rumours, University Alerts
                    and "all" pages.

A video only loads its YouTube player when it's clicked
(thumbnail first), so a page with 12 videos stays fast.
=========================================================
*/

(function () {

    "use strict";

    function escapeVideoHTML(value) {

        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function isVideoId(value) {

        return /^[A-Za-z0-9_-]{11}$/.test(String(value || ""));
    }

    function formatVideoDate(value) {

        const date = new Date(value);

        if (isNaN(date.getTime())) return "";

        return date.toLocaleDateString("en-KE", {
            year: "numeric",
            month: "short",
            day: "numeric"
        });
    }

    function injectVideoStyles() {

        if (document.getElementById("hsVideoStyles")) return;

        const style = document.createElement("style");

        style.id = "hsVideoStyles";

        // Neutral, semi-transparent colours so the row looks right
        // on both light and dark versions of the site.
        style.textContent = `
            .hs-videos {
                margin: 0 0 24px;
            }
            .hs-videos-head {
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: 12px;
                flex-wrap: wrap;
                margin-bottom: 10px;
            }
            .hs-videos-head h3 {
                margin: 0;
                font-size: 1.15rem;
            }
            .hs-videos-note {
                font-size: 0.82rem;
                opacity: 0.7;
            }
            .hs-videos-rail {
                display: flex;
                gap: 14px;
                overflow-x: auto;
                padding-bottom: 8px;
                scroll-snap-type: x proximity;
                -webkit-overflow-scrolling: touch;
            }
            .hs-video-card {
                flex: 0 0 280px;
                max-width: 82vw;
                scroll-snap-align: start;
                border: 1px solid rgba(127, 127, 127, 0.28);
                border-radius: 12px;
                background: rgba(127, 127, 127, 0.08);
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }
            .hs-video-stage {
                position: relative;
                width: 100%;
                aspect-ratio: 16 / 9;
                background: #000;
            }
            .hs-video-thumb {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                padding: 0;
                margin: 0;
                border: 0;
                cursor: pointer;
                background: #000;
                display: block;
            }
            .hs-video-thumb img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }
            .hs-video-play {
                position: absolute;
                left: 50%;
                top: 50%;
                transform: translate(-50%, -50%);
                width: 52px;
                height: 52px;
                border-radius: 50%;
                background: rgba(0, 0, 0, 0.72);
                color: #fff;
                font-size: 22px;
                line-height: 52px;
                text-align: center;
                padding-left: 3px;
                box-sizing: border-box;
            }
            .hs-video-thumb:hover .hs-video-play,
            .hs-video-thumb:focus-visible .hs-video-play {
                background: #c00;
            }
            .hs-video-stage iframe {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                border: 0;
            }
            .hs-video-body {
                padding: 10px 12px 12px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                flex: 1;
            }
            .hs-video-body h4 {
                margin: 0;
                font-size: 0.95rem;
                line-height: 1.3;
                display: -webkit-box;
                -webkit-line-clamp: 3;
                -webkit-box-orient: vertical;
                overflow: hidden;
            }
            .hs-video-meta {
                margin: 0;
                font-size: 0.8rem;
                opacity: 0.72;
            }
            .hs-video-link {
                margin-top: auto;
                font-size: 0.82rem;
                font-weight: 600;
                text-decoration: none;
            }
            .hs-videos-empty {
                margin: 0;
                padding: 12px 14px;
                border: 1px dashed rgba(127, 127, 127, 0.4);
                border-radius: 10px;
                font-size: 0.9rem;
                opacity: 0.8;
            }
        `;

        document.head.appendChild(style);
    }

    function videoCardHTML(video) {

        const id = video.id;
        const title = escapeVideoHTML(video.title || "Campus news video");
        const meta = [
            video.channel,
            formatVideoDate(video.published)
        ]
            .filter(Boolean)
            .map(escapeVideoHTML)
            .join(" · ");

        return `
            <article class="hs-video-card" data-video-id="${id}">
                <div class="hs-video-stage">
                    <button type="button" class="hs-video-thumb" aria-label="Play video: ${title}">
                        <img
                            src="https://i.ytimg.com/vi/${id}/hqdefault.jpg"
                            alt=""
                            loading="lazy"
                            referrerpolicy="no-referrer"
                        >
                        <span class="hs-video-play" aria-hidden="true">▶</span>
                    </button>
                </div>
                <div class="hs-video-body">
                    <h4>${title}</h4>
                    ${meta ? `<p class="hs-video-meta">${meta}</p>` : ""}
                    <a
                        class="hs-video-link"
                        href="https://www.youtube.com/watch?v=${id}"
                        target="_blank"
                        rel="noopener noreferrer"
                    >Watch on YouTube ↗</a>
                </div>
            </article>
        `;
    }

    // Swap the thumbnail for the real player when it is clicked.
    function attachPlayHandlers(root) {

        root.addEventListener("click", function (event) {

            const button = event.target.closest(".hs-video-thumb");

            if (!button) return;

            const card = button.closest(".hs-video-card");
            const id = card && card.getAttribute("data-video-id");

            if (!isVideoId(id)) return;

            const stage = button.parentElement;

            const frame = document.createElement("iframe");

            frame.src =
                `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`;
            frame.title = "Campus news video";
            frame.allow =
                "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
            frame.allowFullscreen = true;

            stage.innerHTML = "";
            stage.appendChild(frame);
        });
    }

    async function loadVideoList(limit) {

        const response = await fetch(
            `/api/university-videos?limit=${limit}&t=${Date.now()}`,
            { cache: "no-store", headers: { "Accept": "application/json" } }
        );

        if (!response.ok) {

            throw new Error(`Videos API returned HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data || !Array.isArray(data.videos)) {

            throw new Error("Videos API returned invalid data.");
        }

        return data.videos.filter(video => isVideoId(video && video.id));
    }

    async function mountVideoRail(target, options) {

        if (!target) return;

        const settings = Object.assign(
            { title: "🎥 Latest Campus Videos", limit: 12, before: false },
            options || {}
        );

        injectVideoStyles();

        const section = document.createElement("section");

        section.className = "hs-videos";
        section.setAttribute("aria-label", "Latest campus videos");

        section.innerHTML = `
            <div class="hs-videos-head">
                <h3>${escapeVideoHTML(settings.title)}</h3>
                <span class="hs-videos-note">Recent university news clips from YouTube</span>
            </div>
            <p class="hs-videos-empty">⏳ Loading videos...</p>
        `;

        if (settings.before) {

            target.parentNode.insertBefore(section, target);

        } else {

            target.appendChild(section);
        }

        try {

            const videos = await loadVideoList(settings.limit);

            if (!videos.length) {

                section.querySelector(".hs-videos-empty").textContent =
                    "No recent campus videos right now — check back soon.";

                return;
            }

            section.querySelector(".hs-videos-empty").outerHTML =
                `<div class="hs-videos-rail">${videos.map(videoCardHTML).join("")}</div>`;

            attachPlayHandlers(section);

        } catch (error) {

            console.error("Campus videos error:", error);

            section.querySelector(".hs-videos-empty").textContent =
                "Couldn't load videos right now. Please try again later.";
        }
    }

    function autoMount() {

        // Homepage
        const home = document.getElementById("homeVideos");

        if (home) {

            mountVideoRail(home, { limit: 12 });
        }

        // Category pages that show campus news
        if (document.body.classList.contains("page-category")) {

            const type = String(
                new URLSearchParams(window.location.search).get("type") || "all"
            ).toLowerCase();

            const list = document.getElementById("articlesList");

            if (list && ["rumours", "university-alerts", "all"].includes(type)) {

                mountVideoRail(list, {
                    limit: 12,
                    before: true,
                    title: type === "university-alerts"
                        ? "🎥 Videos on Campus Alerts"
                        : "🎥 Latest Campus Videos"
                });
            }
        }
    }

    window.mountCampusVideos = mountVideoRail;

    if (document.readyState === "loading") {

        document.addEventListener("DOMContentLoaded", autoMount);

    } else {

        autoMount();
    }

})();