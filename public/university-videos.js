/*
=========================================================
CAMPUS VIDEOS (YouTube, TikTok, Facebook, Instagram, X)
=========================================================

A horizontally scrolling row of videos that match the page the
visitor is on. Reads  GET /api/university-videos?topic=...

Self-mounting - add this one script to a page and it works:
  - index.html:      fills <div id="homeVideos">  (all topics)
  - category.html:   inserts a row above #articlesList for EVERY
                     category (HELB, KUCCPS, Jobs, Scholarships,
                     Rumours, University Alerts, Internships,
                     Attachments, Competitions, Courses, search)
  - article.html:    adds a row under the article, matched to the
                     article's category (article.js calls
                     window.mountCampusVideos)

Manual use:
  mountCampusVideos(element, { topic: "helb", q: "", title: "", before: false })

YouTube and TikTok/Instagram/Facebook clips play inside the
page when tapped. X posts open on X.
=========================================================
*/

(function () {

    "use strict";

    const PLATFORMS = {
        youtube:   { label: "YouTube",   color: "#e62117", icon: "▶" },
        tiktok:    { label: "TikTok",    color: "#111111", icon: "♪" },
        facebook:  { label: "Facebook",  color: "#1877f2", icon: "f" },
        instagram: { label: "Instagram", color: "#c13584", icon: "◎" },
        x:         { label: "X",         color: "#000000", icon: "𝕏" }
    };

    // Vertical (phone-style) players need a taller stage.
    const VERTICAL = { tiktok: true, instagram: true };

    // Topic -> default section title.
    const TOPIC_TITLES = {
        all: "🎥 Latest Campus Videos",
        helb: "🎥 HELB Videos",
        kuccps: "🎥 KUCCPS Videos",
        jobs: "🎥 Jobs & Career Videos",
        scholarships: "🎥 Scholarship Videos",
        rumours: "🎥 Campus Rumours Videos",
        "university-alerts": "🎥 Videos on Campus Alerts",
        internships: "🎥 Internship Videos",
        attachments: "🎥 Attachment Videos",
        competitions: "🎥 Competition Videos",
        courses: "🎥 Course & Career Videos"
    };

    function esc(value) {

        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function platformOf(video) {

        return PLATFORMS[video.platform] ? video.platform : "youtube";
    }

    function safeId(video) {

        return /^[A-Za-z0-9_-]{1,40}$/.test(String(video.id || ""));
    }

    function safeUrl(value) {

        return /^https:\/\/(www\.)?(youtube\.com|youtu\.be|tiktok\.com|facebook\.com|fb\.watch|instagram\.com|x\.com|twitter\.com)\//i
            .test(String(value || ""))
            ? value
            : "";
    }

    function formatDate(video) {

        if (video.published) {

            const date = new Date(video.published);

            if (!isNaN(date.getTime())) {

                return date.toLocaleDateString("en-KE", {
                    year: "numeric",
                    month: "short",
                    day: "numeric"
                });
            }
        }

        return video.dateText || "";
    }

    /*
    Which iframe (if any) can play this video inside the page.
    Returns "" when the platform only allows opening it on its own site.
    */
    function embedUrl(video) {

        const platform = platformOf(video);

        if (platform === "youtube" && safeId(video)) {

            return `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0&playsinline=1`;
        }

        if (platform === "tiktok" && /^\d{8,25}$/.test(String(video.id))) {

            return `https://www.tiktok.com/embed/v2/${video.id}`;
        }

        if (platform === "instagram" && safeId(video)) {

            return `https://www.instagram.com/reel/${video.id}/embed`;
        }

        if (platform === "facebook" && safeUrl(video.url)) {

            return "https://www.facebook.com/plugins/video.php?show_text=false&autoplay=true&href=" +
                encodeURIComponent(video.url);
        }

        return "";
    }

    function injectStyles() {

        if (document.getElementById("hsVideoStyles")) return;

        const style = document.createElement("style");

        style.id = "hsVideoStyles";

        // Neutral, semi-transparent colours so the row looks right
        // on both light and dark versions of the site.
        style.textContent = `
            .hs-videos { margin: 0 0 24px; position: relative; }
            .hs-videos-head {
                display: flex; align-items: baseline; justify-content: space-between;
                gap: 12px; flex-wrap: wrap; margin-bottom: 10px;
            }
            .hs-videos-head h3 { margin: 0; font-size: 1.15rem; }
            .hs-videos-note { font-size: 0.82rem; opacity: 0.7; }
            .hs-video-filters { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 10px; }
            .hs-video-filter {
                border: 1px solid rgba(127,127,127,0.4); background: transparent; color: inherit;
                border-radius: 999px; padding: 4px 12px; font-size: 0.8rem; cursor: pointer;
            }
            .hs-video-filter.is-active { background: rgba(127,127,127,0.28); font-weight: 600; }
            .hs-videos-wrap { position: relative; }
            .hs-videos-rail {
                display: flex; gap: 14px; overflow-x: auto; padding-bottom: 8px;
                scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch;
                scroll-behavior: smooth;
            }
            .hs-rail-arrow {
                position: absolute; top: 38%; z-index: 3; width: 36px; height: 36px;
                border-radius: 50%; border: 0; cursor: pointer; font-size: 18px; line-height: 36px;
                background: rgba(0,0,0,0.65); color: #fff; padding: 0;
            }
            .hs-rail-arrow:hover { background: rgba(0,0,0,0.85); }
            .hs-rail-prev { left: -6px; }
            .hs-rail-next { right: -6px; }
            @media (hover: none) { .hs-rail-arrow { display: none; } }
            .hs-video-card {
                flex: 0 0 280px; max-width: 82vw; scroll-snap-align: start;
                border: 1px solid rgba(127,127,127,0.28); border-radius: 12px;
                background: rgba(127,127,127,0.08); overflow: hidden;
                display: flex; flex-direction: column;
            }
            .hs-video-stage { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; }
            .hs-video-stage.is-vertical { aspect-ratio: 9 / 16; }
            .hs-video-thumb {
                position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; margin: 0;
                border: 0; cursor: pointer; background: #000; display: block;
                text-decoration: none; color: #fff;
            }
            .hs-video-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
            .hs-video-fallback {
                position: absolute; inset: 0; display: flex; align-items: center;
                justify-content: center; font-size: 42px; color: #fff;
            }
            .hs-video-badge {
                position: absolute; left: 8px; top: 8px; z-index: 2; padding: 2px 8px;
                border-radius: 999px; font-size: 0.72rem; font-weight: 700; color: #fff;
            }
            .hs-video-play {
                position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
                width: 52px; height: 52px; border-radius: 50%; background: rgba(0,0,0,0.72);
                color: #fff; font-size: 22px; line-height: 52px; text-align: center;
                padding-left: 3px; box-sizing: border-box;
            }
            .hs-video-thumb:hover .hs-video-play,
            .hs-video-thumb:focus-visible .hs-video-play { background: #c00; }
            .hs-video-stage iframe {
                position: absolute; inset: 0; width: 100%; height: 100%; border: 0;
            }
            .hs-video-body {
                padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; flex: 1;
            }
            .hs-video-body h4 {
                margin: 0; font-size: 0.95rem; line-height: 1.3; display: -webkit-box;
                -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
            }
            .hs-video-meta { margin: 0; font-size: 0.8rem; opacity: 0.72; }
            .hs-video-link { margin-top: auto; font-size: 0.82rem; font-weight: 600; text-decoration: none; }
            .hs-videos-empty {
                margin: 0; padding: 12px 14px; border: 1px dashed rgba(127,127,127,0.4);
                border-radius: 10px; font-size: 0.9rem; opacity: 0.8;
            }
        `;

        document.head.appendChild(style);
    }

    function cardHTML(video) {

        const platform = platformOf(video);
        const info = PLATFORMS[platform];
        const title = esc(video.title || "Campus video");
        const url = safeUrl(video.url);
        const canEmbed = Boolean(embedUrl(video));
        const meta = [video.channel, formatDate(video)].filter(Boolean).map(esc).join(" · ");
        const thumb = video.thumbnail && /^https:\/\//.test(video.thumbnail) ? video.thumbnail : "";

        const inner = `
            <span class="hs-video-badge" style="background:${info.color}">${info.icon} ${info.label}</span>
            <span class="hs-video-fallback" style="background:${info.color}" aria-hidden="true">${info.icon}</span>
            ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
            <span class="hs-video-play" aria-hidden="true">${canEmbed ? "▶" : "↗"}</span>
        `;

        const stage = canEmbed
            ? `<button type="button" class="hs-video-thumb" aria-label="Play video: ${title}">${inner}</button>`
            : `<a class="hs-video-thumb" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open on ${info.label}: ${title}">${inner}</a>`;

        return `
            <article class="hs-video-card" data-key="${esc(platform)}:${esc(video.id)}">
                <div class="hs-video-stage${canEmbed && VERTICAL[platform] ? " is-vertical" : ""}">
                    ${stage}
                </div>
                <div class="hs-video-body">
                    <h4>${title}</h4>
                    ${meta ? `<p class="hs-video-meta">${meta}</p>` : ""}
                    ${url ? `<a class="hs-video-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Watch on ${info.label} ↗</a>` : ""}
                </div>
            </article>
        `;
    }

    function attachHandlers(section, videos) {

        const byKey = new Map(
            videos.map(v => [`${platformOf(v)}:${v.id}`, v])
        );

        // Broken thumbnails fall back to the coloured platform tile.
        section.addEventListener("error", function (event) {

            if (event.target && event.target.tagName === "IMG") {

                event.target.remove();
            }
        }, true);

        // Tap a thumbnail -> play it right there.
        section.addEventListener("click", function (event) {

            const button = event.target.closest("button.hs-video-thumb");

            if (!button) return;

            const card = button.closest(".hs-video-card");
            const video = card && byKey.get(card.getAttribute("data-key"));
            const src = video && embedUrl(video);

            if (!src) return;

            const stage = button.parentElement;
            const frame = document.createElement("iframe");

            frame.src = src;
            frame.title = "Campus video";
            frame.allow =
                "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";
            frame.allowFullscreen = true;

            stage.innerHTML = "";
            stage.appendChild(frame);
        });
    }

    function buildRail(section, videos) {

        const counts = {};

        videos.forEach(v => {

            const p = platformOf(v);

            counts[p] = (counts[p] || 0) + 1;
        });

        const present = Object.keys(PLATFORMS).filter(p => counts[p]);

        const filters =
            present.length > 1
                ? `<div class="hs-video-filters">
                        <button type="button" class="hs-video-filter is-active" data-platform="all">All (${videos.length})</button>
                        ${present.map(p =>
                            `<button type="button" class="hs-video-filter" data-platform="${p}">${PLATFORMS[p].label} (${counts[p]})</button>`
                        ).join("")}
                   </div>`
                : "";

        section.querySelector(".hs-videos-empty").outerHTML = `
            ${filters}
            <div class="hs-videos-wrap">
                <button type="button" class="hs-rail-arrow hs-rail-prev" aria-label="Scroll left">‹</button>
                <div class="hs-videos-rail"></div>
                <button type="button" class="hs-rail-arrow hs-rail-next" aria-label="Scroll right">›</button>
            </div>
        `;

        const rail = section.querySelector(".hs-videos-rail");

        function paint(platform) {

            const list = platform === "all"
                ? videos
                : videos.filter(v => platformOf(v) === platform);

            rail.innerHTML = list.map(cardHTML).join("");
            rail.scrollLeft = 0;
        }

        paint("all");

        section.querySelectorAll(".hs-video-filter").forEach(button => {

            button.addEventListener("click", () => {

                section.querySelectorAll(".hs-video-filter")
                    .forEach(b => b.classList.toggle("is-active", b === button));

                paint(button.getAttribute("data-platform"));
            });
        });

        const step = () => Math.max(260, Math.round(rail.clientWidth * 0.85));

        section.querySelector(".hs-rail-prev")
            .addEventListener("click", () => rail.scrollBy({ left: -step() }));

        section.querySelector(".hs-rail-next")
            .addEventListener("click", () => rail.scrollBy({ left: step() }));

        attachHandlers(section, videos);
    }

    async function loadVideoList(topic, q, limit) {

        const params = new URLSearchParams({ topic, limit: String(limit), t: String(Date.now()) });

        if (q) params.set("q", q);

        const response = await fetch(
            `/api/university-videos?${params.toString()}`,
            { cache: "no-store", headers: { "Accept": "application/json" } }
        );

        if (!response.ok) {

            throw new Error(`Videos API returned HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data || !Array.isArray(data.videos)) {

            throw new Error("Videos API returned invalid data.");
        }

        return data.videos.filter(video => video && safeId(video) && safeUrl(video.url));
    }

    async function mountVideoRail(target, options) {

        if (!target || target.dataset.hsVideosMounted === "1") return;

        const settings = Object.assign(
            { topic: "all", q: "", title: "", limit: 20, before: false },
            options || {}
        );

        const topic = String(settings.topic || "all").toLowerCase();

        const title =
            settings.title ||
            (settings.q ? `🎥 Videos: ${settings.q}` : TOPIC_TITLES[topic] || TOPIC_TITLES.all);

        target.dataset.hsVideosMounted = "1";

        injectStyles();

        const section = document.createElement("section");

        section.className = "hs-videos";
        section.setAttribute("aria-label", title);

        section.innerHTML = `
            <div class="hs-videos-head">
                <h3>${esc(title)}</h3>
                <span class="hs-videos-note">YouTube, TikTok, Facebook, Instagram &amp; X · scroll →</span>
            </div>
            <p class="hs-videos-empty">⏳ Loading videos...</p>
        `;

        if (settings.before) {

            target.parentNode.insertBefore(section, target);

        } else {

            target.appendChild(section);
        }

        try {

            const videos = await loadVideoList(topic, settings.q, settings.limit);

            if (!videos.length) {

                section.querySelector(".hs-videos-empty").textContent =
                    "No recent videos for this topic right now — check back soon.";

                return;
            }

            buildRail(section, videos);

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

            mountVideoRail(home, { topic: "all", limit: 20 });
        }

        // Every category page (works with or without the page-category class)
        const list = document.getElementById("articlesList");

        const isCategoryPage =
            document.body.classList.contains("page-category") ||
            /category\.html$/i.test(window.location.pathname) ||
            /\/category\/?$/i.test(window.location.pathname);

        if (list && isCategoryPage) {

            const params = new URLSearchParams(window.location.search);

            const type = String(params.get("type") || "all").trim().toLowerCase();

            let topic = type;
            let q = "";

            if (type === "search") {

                topic = "all";
                q = String(params.get("q") || "").trim();

            } else if (type === "courses") {

                q = String(params.get("field") || "").replace(/-/g, " ").trim();
            }

            mountVideoRail(list, { topic, q, before: true });
        }
    }

    window.mountCampusVideos = mountVideoRail;

    if (document.readyState === "loading") {

        document.addEventListener("DOMContentLoaded", autoMount);

    } else {

        autoMount();
    }

})();