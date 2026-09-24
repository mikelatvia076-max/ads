/*
=========================================================
KENYA CAMPUS HUB - ARTICLE PAGE
Loads and displays a single article on its own
dedicated, bookmarkable page.
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

function linkify(safeText) {
    return safeText.replace(
        /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/*
Turns the plain-text article body into structured HTML:
short unpunctuated lines become headings, "Label: text" lines
become term rows, and runs of short lines become bullet lists.
*/
function formatArticleContent(content) {
    if (!content) {
        return "<p>No additional information available.</p>";
    }

    const TERM = /^([^:.\n]{2,45}):\s+(\S[\s\S]*)$/;
    const BULLET = /^\s*[-•*–]\s+/;
    const blocks = String(content).split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

    let html = "";
    let terms = [];

    const flush = () => {
        if (terms.length) {
            html += `<ul class="term-list">${terms.join("")}</ul>`;
            terms = [];
        }
    };
    const termItem = (label, text) =>
        `<li><strong>${escapeHTML(label)}</strong><span>${linkify(escapeHTML(text))}</span></li>`;
    const isTerm = m => m && m[1].split(/\s+/).length <= 6;
    const termLike = m => isTerm(m) && (/[.!?]$/.test(m[2]) || m[2].length > 60);

    for (const block of blocks) {
        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);

        if (lines.length === 1) {
            const line = lines[0];
            const m = line.match(TERM);

            if (termLike(m)) {
                terms.push(termItem(m[1], m[2]));
                continue;
            }
            flush();
            if (line.length <= 80 && !/[.!?]$/.test(line) && line.split(/\s+/).length <= 12) {
                html += `<h2>${escapeHTML(line.replace(/:$/, ""))}</h2>`;
            } else {
                html += `<p>${linkify(escapeHTML(line))}</p>`;
            }
            continue;
        }

        const matches = lines.map(l => l.match(TERM));
        if (matches.every(termLike)) {
            matches.forEach(m => terms.push(termItem(m[1], m[2])));
            continue;
        }

        flush();
        if (lines.every(l => l.length <= 90 && /^[A-Z0-9•\-*–]/.test(l))) {
            html += `<ul class="bullet-list">${lines
                .map(l => `<li>${linkify(escapeHTML(l.replace(BULLET, "")))}</li>`)
                .join("")}</ul>`;
        } else {
            html += `<p>${lines.map(l => linkify(escapeHTML(l))).join("<br>")}</p>`;
        }
    }

    flush();
    return html;
}

function getArticleIdFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get("id") || "";
}

/*
=========================================================
LOAD ARTICLE
=========================================================
*/

async function loadArticlePage() {

    const id = getArticleIdFromURL();
    const container = $("articleContainer");

    if (!id) {
        if (container) {
            container.innerHTML = `
                <article class="full-article">
                    <h1>Article not found</h1>
                    <p>No article was specified.</p>
                    <button
                        type="button"
                        onclick="location.href='index.html'"
                    >
                        ← Back to HigherSpace Connect
                    </button>
                </article>
            `;
        }
        return;
    }

    try {

        const response = await fetch(
            `/api/article/${encodeURIComponent(id)}?t=${Date.now()}`,
            {
                method: "GET",
                cache: "no-store",
                headers: { "Accept": "application/json" }
            }
        );

        if (!response.ok) {
            throw new Error(`Article API returned HTTP ${response.status}`);
        }

        const article = await response.json();

        renderArticle(article);

    } catch (error) {

        console.error("Unable to load article:", error);

        if (container) {
            container.innerHTML = `
                <article class="full-article">
                    <h1>Unable to load this article</h1>
                    <p>Please check your connection and try again.</p>
                    <button
                        type="button"
                        onclick="location.href='index.html'"
                    >
                        ← Back to HigherSpace Connect
                    </button>
                </article>
            `;
        }
    }
}

/*
=========================================================
RENDER ARTICLE
=========================================================
*/

function renderArticle(article) {

    const container = $("articleContainer");
    if (!container) return;

    const title = escapeHTML(article.title || "Student Information");
    const category = escapeHTML(article.category || "General");
    const organization = escapeHTML(article.organization || article.source || "");
    const description = escapeHTML(article.description || article.summary || "");
    const whyItMatters = escapeHTML(article.whyItMatters || "");
    const content = article.content || article.description || article.summary || "No additional article content available.";
    const sourceURL = article.url || "";

    const publishedDate = article.publishedDate || article.date || "";
    const updatedDate = article.updatedAt || article.updated || "";
    const deadline = article.expiresAt || article.deadline;

    let dateText = "";
    if (publishedDate) {
        const date = new Date(publishedDate);
        if (!Number.isNaN(date.getTime())) {
            dateText = date.toLocaleDateString("en-KE", {
                year: "numeric",
                month: "long",
                day: "numeric"
            });
        }
    }

    let updatedText = "";
    if (updatedDate) {
        const date = new Date(updatedDate);
        if (!Number.isNaN(date.getTime())) {
            updatedText = date.toLocaleString("en-KE");
        }
    }

    let deadlineText = "";
    if (deadline && deadline !== "null") {
        const deadlineDate = new Date(deadline);
        if (!Number.isNaN(deadlineDate.getTime())) {
            deadlineText = deadlineDate.toLocaleDateString("en-KE", {
                year: "numeric",
                month: "long",
                day: "numeric"
            });
        }
    }

    document.title = `${title} - HigherSpace Connect`;

    const categorySlug = HS_catType(article.category);
    const backHref = categorySlug
        ? `category.html?type=${encodeURIComponent(categorySlug)}`
        : "index.html";

    const dl = HS_deadlineInfo(deadline);
    const words = String(content).trim().split(/\s+/).length;
    const minutes = Math.max(1, Math.round(words / 200));

    container.innerHTML = `
        <article class="full-article" data-cat="${escapeHTML(HS_catKey(article.category || "general"))}">

            <header class="article-head">
                <span class="article-category">${category}</span>

                <h1>${title}</h1>

                <div class="article-meta">
                    ${organization ? `<span>🏢 <strong>${organization}</strong></span>` : ""}
                    ${dateText ? `<span>📅 Published ${dateText}</span>` : ""}
                    ${updatedText ? `<span>🔄 Updated ${escapeHTML(updatedText)}</span>` : ""}
                    <span>⏱ ${minutes} min read</span>
                </div>
            </header>

            ${dl ? `
                <div class="callout callout-deadline is-${dl.level}">
                    <strong>⏰ Application deadline: ${deadlineText}</strong>
                    <span class="deadline-chip is-${dl.level}">${dl.label}</span>
                </div>
            ` : ""}

            ${description ? `<p class="article-summary">${description}</p>` : ""}

            <div class="article-body">
                ${formatArticleContent(content)}
            </div>

            ${whyItMatters ? `
                <div class="callout callout-why">
                    <strong>💡 Why it matters</strong>
                    <p>${whyItMatters}</p>
                </div>
            ` : ""}

            <div class="article-actions">
                ${sourceURL ? `
                    <a
                        class="source-link"
                        href="${escapeHTML(sourceURL)}"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        🔗 View official source
                    </a>
                ` : ""}

                <button
                    type="button"
                    class="back-btn"
                    onclick="location.href='${backHref}'"
                >
                    ← Back
                </button>
            </div>

        </article>
    `;

    setupReadProgress();
}

/* Thin reading-progress bar along the top of the page */
function setupReadProgress() {
    let bar = $("readProgress");
    if (!bar) {
        bar = document.createElement("div");
        bar.id = "readProgress";
        bar.className = "read-progress";
        document.body.appendChild(bar);
        window.addEventListener("scroll", () => {
            const max = document.documentElement.scrollHeight - window.innerHeight;
            bar.style.width = (max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0) + "%";
        }, { passive: true });
    }
    const card = document.querySelector(".full-article");
    if (card) bar.dataset.cat = card.dataset.cat || "";
}

/*
=========================================================
INIT
=========================================================
*/

document.addEventListener("DOMContentLoaded", loadArticlePage);

window.loadArticlePage = loadArticlePage;