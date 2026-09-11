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

function formatArticleContent(content) {
    if (!content) {
        return `
            <p>
                No additional information available.
            </p>
        `;
    }

    return String(content)
        .split(/\n{2,}/)
        .map(paragraph => {
            const safe = escapeHTML(paragraph).replace(/\n/g, "<br>");
            return `<p>${safe}</p>`;
        })
        .join("");
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
                        ← Back to Kenya Campus Hub
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
                        ← Back to Kenya Campus Hub
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
    const deadline = article.deadline;

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

    document.title = `${title} - Kenya Campus Hub`;

    const categorySlug = String(article.category || "").trim().toLowerCase();
    const backHref = categorySlug
        ? `category.html?type=${encodeURIComponent(categorySlug)}`
        : "index.html";

    container.innerHTML = `
        <article class="full-article">

            <span class="article-category">
                ${category}
            </span>

            <h1>
                ${title}
            </h1>

            ${organization ? `
                <p>
                    🏢 <strong>${organization}</strong>
                </p>
            ` : ""}

            ${dateText ? `
                <small style="display:block; margin-bottom:5px;">
                    📅 Published: ${dateText}
                </small>
            ` : ""}

            ${updatedText ? `
                <small style="display:block; margin-bottom:10px;">
                    🔄 Last updated: ${escapeHTML(updatedText)}
                </small>
            ` : ""}

            ${deadlineText ? `
                <div style="margin:20px 0; padding:15px; border-radius:10px;">
                    ⏰ <strong>Application Deadline:</strong> ${deadlineText}
                </div>
            ` : ""}

            ${description ? `
                <div class="article-summary" style="margin:20px 0;">
                    <strong>Summary</strong>
                    <p>${description}</p>
                </div>
            ` : ""}

            <div class="article-body">
                ${formatArticleContent(content)}
            </div>

            ${whyItMatters ? `
                <div style="margin-top:25px; padding:15px; border-radius:10px;">
                    <strong>💡 Why it matters</strong>
                    <p>${whyItMatters}</p>
                </div>
            ` : ""}

            ${sourceURL ? `
                <p style="margin-top:25px;">
                    <a
                        href="${escapeHTML(sourceURL)}"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        🔗 View Official Source
                    </a>
                </p>
            ` : ""}

            <br>

            <button
                type="button"
                onclick="location.href='${backHref}'"
            >
                ← Back
            </button>

        </article>
    `;
}

/*
=========================================================
INIT
=========================================================
*/

document.addEventListener("DOMContentLoaded", loadArticlePage);

window.loadArticlePage = loadArticlePage;