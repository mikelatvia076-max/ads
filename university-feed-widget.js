/*
=========================================================
MY CAMPUS — LIVE PER-UNIVERSITY FEED WIDGET
=========================================================

Loaded AFTER app.js on index.html, so the setMyCampus() /
clearMyCampus() defined here take over from any placeholder
versions app.js may define — this file is the real, API-backed
implementation.

Talks to:
  GET /api/university-feed/:id

which returns real, live-fetched News / Announcements /
Opportunities for the chosen institution (see university-feed.js
on the server — powered by GNews, not AI-generated).
=========================================================
*/

(function () {

    const STORAGE_KEY = "hsc_my_campus";

    const CATEGORY_META = {
        news: { label: "📰 News", cssClass: "cat-news" },
        announcements: { label: "📢 Announcements", cssClass: "cat-announcements" },
        opportunities: { label: "🎯 Opportunities", cssClass: "cat-opportunities" }
    };

    function el(tag, className, html) {

        const node = document.createElement(tag);

        if (className) node.className = className;
        if (html !== undefined) node.innerHTML = html;

        return node;
    }

    function formatDate(dateString) {

        if (!dateString) return "";

        const date = new Date(dateString);

        if (isNaN(date)) return "";

        return date.toLocaleDateString("en-KE", {
            day: "numeric",
            month: "short",
            year: "numeric"
        });
    }

    function escapeHtml(text) {

        return String(text || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function renderSection(categoryKey, articles) {

        const meta = CATEGORY_META[categoryKey];

        const section = el("div", "my-campus-feed-section");

        section.appendChild(
            el("h3", "my-campus-feed-heading", escapeHtml(meta.label))
        );

        if (!articles || articles.length === 0) {

            section.appendChild(
                el(
                    "p",
                    "my-campus-feed-empty",
                    "No recent updates found for this category right now — check back soon."
                )
            );

            return section;
        }

        const grid = el("div", "opportunities-grid");

        articles.forEach(article => {

            const card = document.createElement("a");

            card.className = `opportunity-card ${meta.cssClass}`;
            card.href = article.sourceUrl || "#";
            card.target = "_blank";
            card.rel = "noopener noreferrer";

            card.appendChild(
                el("h3", null, escapeHtml(article.title))
            );

            card.appendChild(
                el("p", null, escapeHtml(article.summary))
            );

            const metaLine = [article.source, formatDate(article.date)]
                .filter(Boolean)
                .join(" · ");

            if (metaLine) {

                card.appendChild(
                    el("p", "my-campus-feed-source", escapeHtml(metaLine))
                );
            }

            grid.appendChild(card);
        });

        section.appendChild(grid);

        return section;
    }

    function populateInstitutionSelect(institutions) {

        const select = document.getElementById("myCampusSelect");

        if (!select) return;

        // Replace whatever placeholder options index.html shipped with
        // (previously a hardcoded list of 7) with the full, live list
        // of CUE-accredited universities served by the backend, so the
        // dropdown always matches university-feed.js exactly.
        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Select your institution...";
        select.appendChild(placeholder);

        institutions
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(({ id, name }) => {

                const option = document.createElement("option");
                option.value = id;
                option.textContent = name;
                select.appendChild(option);
            });
    }

    async function loadInstitutionList() {

        try {

            const response = await fetch("/api/university-feed/institutions");
            const data = await response.json();

            if (data.success && Array.isArray(data.institutions)) {

                populateInstitutionSelect(data.institutions);
            }

        } catch (error) {

            console.error("My Campus institution list error:", error);
            // Leave whatever options index.html already has as a fallback.
        }
    }

    function renderLoading(container) {

        container.innerHTML = "";
        container.appendChild(
            el("p", "my-campus-feed-loading", "Loading real, live updates for your campus...")
        );
    }

    function renderError(container) {

        container.innerHTML = "";
        container.appendChild(
            el(
                "p",
                "my-campus-feed-empty",
                "Couldn't load live updates right now. Please try again in a moment."
            )
        );
    }

    async function renderFeed(institutionId) {

        const feedContainer = document.getElementById("myCampusFeed");

        if (!feedContainer) return;

        renderLoading(feedContainer);

        try {

            const response = await fetch(`/api/university-feed/${encodeURIComponent(institutionId)}`);
            const data = await response.json();

            if (!data.success) {

                renderError(feedContainer);
                return;
            }

            feedContainer.innerHTML = "";

            feedContainer.appendChild(renderSection("news", data.news));
            feedContainer.appendChild(renderSection("announcements", data.announcements));
            feedContainer.appendChild(renderSection("opportunities", data.opportunities));

        } catch (error) {

            console.error("My Campus feed error:", error);
            renderError(feedContainer);
        }
    }

    function ensureFeedContainer() {

        let feedContainer = document.getElementById("myCampusFeed");

        if (!feedContainer) {

            feedContainer = el("div", "my-campus-feed");
            feedContainer.id = "myCampusFeed";

            const result = document.getElementById("myCampusResult");
            const changeLink = document.getElementById("myCampusChangeLink");

            if (result && changeLink) {

                result.insertBefore(feedContainer, changeLink);

            } else if (result) {

                result.appendChild(feedContainer);
            }
        }

        return feedContainer;
    }

    function showResult(institutionId, institutionName) {

        const picker = document.getElementById("myCampusPicker");
        const result = document.getElementById("myCampusResult");
        const nameEl = document.getElementById("myCampusName");

        if (picker) picker.hidden = true;
        if (result) result.hidden = false;
        if (nameEl) nameEl.textContent = institutionName;

        ensureFeedContainer();
        renderFeed(institutionId);
    }

    // Overrides any earlier definition from app.js — this is the
    // real, API-backed version.
    window.setMyCampus = function () {

        const select = document.getElementById("myCampusSelect");

        if (!select || !select.value) {

            alert("Please select your institution first.");
            return;
        }

        const institutionId = select.value;
        const institutionName = select.options[select.selectedIndex].text;

        try {

            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({ id: institutionId, name: institutionName })
            );

        } catch {

            // localStorage unavailable — feed still works for this visit
        }

        showResult(institutionId, institutionName);
    };

    window.clearMyCampus = function () {

        try {

            localStorage.removeItem(STORAGE_KEY);

        } catch {

            // ignore
        }

        const picker = document.getElementById("myCampusPicker");
        const result = document.getElementById("myCampusResult");
        const select = document.getElementById("myCampusSelect");

        if (picker) picker.hidden = false;
        if (result) result.hidden = true;
        if (select) select.value = "";
    };

    function restoreSavedCampus() {

        let saved = null;

        try {

            saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");

        } catch {

            saved = null;
        }

        if (!saved || !saved.id) return;

        const select = document.getElementById("myCampusSelect");

        if (select) select.value = saved.id;

        showResult(saved.id, saved.name);
    }

    async function init() {

        await loadInstitutionList();
        restoreSavedCampus();
    }

    if (document.readyState === "loading") {

        document.addEventListener("DOMContentLoaded", init);

    } else {

        init();
    }

})();