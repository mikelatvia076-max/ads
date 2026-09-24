/*
=========================================================
KENYA CAMPUS HUB - CATEGORY PAGE
Loads and displays a single category's information
(or search results) on its own dedicated page.
=========================================================
*/
"use strict";

function $(id) {
    return document.getElementById(id);
}

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

const CATEGORY_TITLES = {
    all: "Latest Student Information",
    helb: "HELB Information",
    kuccps: "KUCCPS Information",
    jobs: "Jobs & Internships",
    scholarships: "Scholarships",
    rumours: "University Rumours",
    "university-alerts": "University Alerts",
    internships: "Internships",
    attachments: "Attachments",
    competitions: "Competitions"
};

/*
Internships, Attachments and Competitions are loaded live from
/api/opportunities/:type (Serper.dev search, no AI). The server
already returns card-shaped items with an externalLink.
*/
const OPPORTUNITY_TYPES = ["internships", "attachments", "competitions"];

async function fetchOpportunityArticles(type) {
    const response = await fetch(
        `/api/opportunities/${encodeURIComponent(type)}?t=${Date.now()}`,
        { method: "GET", cache: "no-store", headers: { "Accept": "application/json" } }
    );

    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }

    if (!response.ok) {
        throw new Error((data && data.error) || `Opportunities API returned HTTP ${response.status}`);
    }
    if (!data || !Array.isArray(data.articles)) {
        throw new Error("Opportunities API returned invalid data.");
    }
    return data.articles;
}

function getQueryParams() {
    return new URLSearchParams(window.location.search);
}

function getCategoryFromURL() {
    const params = getQueryParams();
    return String(params.get("type") || "all")
        .trim()
        .toLowerCase();
}

function getSearchQueryFromURL() {
    const params = getQueryParams();
    return String(params.get("q") || "").trim();
}

/*
=========================================================
UNIVERSITY RUMOURS MAPPING

University Rumours are sourced live from NewsData.io via
/api/university-rumours (see university-rumours.js /
server.js), NOT from the AI-generated data/articles.json
store that every other category uses. ai-updater.js has no
"rumours" category and never writes into articles.json, so
/api/content/rumours will always return an empty array.

This maps the NewsData-shaped articles onto the same fields
renderArticles() expects, and marks them with an external
link since they don't exist in the local article store.
=========================================================
*/

function mapRumourArticle(article) {
    return {
        id: article.id || "",
        title: article.title || "University news",
        description: article.description || article.content || "",
        category: "University Rumours",
        organization: article.source_name || article.source_id || "",
        publishedDate: article.pubDate || "",
        externalLink: article.link || ""
    };
}

async function fetchRumourArticles() {
    const response = await fetch(
        `/api/university-rumours?t=${Date.now()}`,
        {
            method: "GET",
            cache: "no-store",
            headers: { "Accept": "application/json" }
        }
    );

    if (!response.ok) {
        let message = `University rumours API returned HTTP ${response.status}`;
        try {
            const errorData = await response.json();
            if (errorData.error) {
                message = errorData.error;
            }
        } catch {
            // ignore JSON parse error, use default message
        }
        throw new Error(message);
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.articles)) {
        throw new Error("University rumours API returned invalid data.");
    }

    return data.articles.map(mapRumourArticle);
}

/*
=========================================================
LOAD CATEGORY PAGE
=========================================================
*/

async function loadCategoryPage() {

    const category = getCategoryFromURL();
    const searchQuery = getSearchQueryFromURL();

    const titleElement = $("categoryTitle");
    let pageTitle;

    if (category === "search") {
        pageTitle = searchQuery
            ? `Search results for "${searchQuery}"`
            : "Search";
    } else {
        pageTitle = CATEGORY_TITLES[category] || "Student Information";
    }

    if (titleElement) {
        titleElement.textContent = pageTitle;
    }

    document.title = `${pageTitle} - HigherSpace Connect`;

    const container = $("articlesList");

    if (container) {
        container.innerHTML = `
            <p class="loading">
                ⏳ Loading latest information...
            </p>
        `;
    }

    try {

        let articles;

        if (category === "search") {

            if (!searchQuery) {
                renderArticles([]);
                return;
            }

            const response = await fetch(
                `/api/search?q=${encodeURIComponent(searchQuery)}&t=${Date.now()}`,
                {
                    method: "GET",
                    cache: "no-store",
                    headers: { "Accept": "application/json" }
                }
            );

            if (!response.ok) {
                throw new Error(`Search API returned HTTP ${response.status}`);
            }

            articles = await response.json();

        } else if (category === "rumours") {

            articles = await fetchRumourArticles();

        } else if (OPPORTUNITY_TYPES.includes(category)) {

            articles = await fetchOpportunityArticles(category);

        } else {

            const endpoint = category === "all"
                ? `/api/content?t=${Date.now()}`
                : `/api/content/${encodeURIComponent(category)}?t=${Date.now()}`;

            const response = await fetch(
                endpoint,
                {
                    method: "GET",
                    cache: "no-store",
                    headers: { "Accept": "application/json" }
                }
            );

            if (!response.ok) {
                throw new Error(`Content API returned HTTP ${response.status}`);
            }

            articles = await response.json();
        }

        if (!Array.isArray(articles)) {
            throw new Error("API returned invalid data.");
        }

        renderArticles(articles);

    } catch (error) {

        console.error("Category loading error:", error);

        if (container) {
            container.innerHTML = `
                <div class="calculator-result">
                    <h3>
                        ⚠️ Unable to load information
                    </h3>
                    <p>
                        We could not load the latest information.
                        Please check that the server is running.
                    </p>
                    ${OPPORTUNITY_TYPES.includes(category)
                        ? `<p><small>${escapeHTML(error.message)}</small></p>`
                        : ""}
                    <button
                        type="button"
                        onclick="loadCategoryPage()"
                    >
                        🔄 Try Again
                    </button>
                </div>
            `;
        }
    }
}

/*
=========================================================
RENDER ARTICLES
=========================================================
*/

function renderArticles(articles) {

    const container = $("articlesList");

    if (!container) return;

    if (!Array.isArray(articles) || articles.length === 0) {
        container.innerHTML = `
            <div class="calculator-result">
                <h3>
                    No information found
                </h3>
                <p>
                    There is currently no information available here.
                </p>
            </div>
        `;
        return;
    }

    const sorted = [...articles].sort((a, b) => {
        const dateA = new Date(
            a.updatedAt || a.publishedDate || a.updated || a.date || 0
        ).getTime();
        const dateB = new Date(
            b.updatedAt || b.publishedDate || b.updated || b.date || 0
        ).getTime();
        return dateB - dateA;
    });

    const count = $("resultCount");
    if (count) {
        count.textContent = `${sorted.length} ${sorted.length === 1 ? "item" : "items"}`;
    }

    container.innerHTML = sorted.map(article => {

        const id = encodeURIComponent(article.id || "");
        const externalLink = article.externalLink || "";
        const title = escapeHTML(article.title || "Untitled Information");
        const summary = escapeHTML(
            article.description || article.summary || "Read the latest student information."
        );
        const category = escapeHTML(article.category || "General");
        const catKey = escapeHTML(HS_catKey(article.category || "general"));
        const organization = escapeHTML(article.organization || article.source || "");
        const status = article.status ? escapeHTML(article.status) : "";

        const dateToShow = article.updatedAt || article.publishedDate || article.updated || article.date || "";
        let formattedDate = "";
        if (dateToShow) {
            const parsedDate = new Date(dateToShow);
            if (!Number.isNaN(parsedDate.getTime())) {
                formattedDate = parsedDate.toLocaleDateString("en-KE", {
                    year: "numeric", month: "short", day: "numeric"
                });
            }
        }

        const dl = HS_deadlineInfo(article.deadline);
        const deadlineDate = dl
            ? dl.date.toLocaleDateString("en-KE", { year: "numeric", month: "short", day: "numeric" })
            : "";

        return `
            <article class="article" data-cat="${catKey}">
                <a
                    class="card-link"
                    href="${externalLink
                        ? escapeHTML(externalLink)
                        : `article.html?id=${id}`}"
                    ${externalLink ? 'target="_blank" rel="noopener noreferrer"' : ""}
                >
                    <div class="article-content">

                        <div class="card-top">
                            <span class="article-category">${category}</span>
                            ${dl ? `<span class="deadline-chip is-${dl.level}">⏰ ${dl.label}</span>` : ""}
                        </div>

                        <h3>${title}</h3>

                        <p class="card-summary">${summary}</p>

                        <div class="card-meta">
                            ${organization ? `<span>🏢 ${organization}</span>` : ""}
                            ${formattedDate ? `<span>🔄 ${formattedDate}</span>` : ""}
                            ${deadlineDate ? `<span>📅 Deadline ${deadlineDate}</span>` : ""}
                        </div>

                        <div class="card-foot">
                            ${status ? `<span class="status-pill">${status}</span>` : "<span></span>"}
                            <span class="card-cta">${externalLink ? "Open source ↗" : "Read more →"}</span>
                        </div>

                    </div>
                </a>
            </article>
        `;
    }).join("");
}

/*
=========================================================
INIT
=========================================================
*/

document.addEventListener("DOMContentLoaded", loadCategoryPage);

window.loadCategoryPage = loadCategoryPage;