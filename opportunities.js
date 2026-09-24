/*
=========================================================
OPPORTUNITIES - Internships, Attachments, Competitions
=========================================================

Loaded LIVE from Serper.dev (a Google Search API) - a different
provider from everything else in this project, and it does NOT
use Groq or any other AI model. It runs searches and cleans up
the results.

SAVED
  Results are written into data/articles.json (the same store
  as every other category), so they survive restarts and also
  show up in site search and the AI chat's site data. A copy is
  kept in data/opportunities-cache.json and used to repair the
  store if another process overwrites articles.json.

UPDATED
  A background timer refreshes each category every
  OPPORTUNITIES_CACHE_MINUTES (default 720 = 12 hours). A visit
  to a stale category also triggers a refresh. New results are
  merged with what is already saved.

REMOVED WHEN THE OPPORTUNITY ENDS
  - Any listing whose text says applications are closed is never
    saved.
  - A deadline written in the result text ("deadline 30 October
    2026") is stored as `deadline` + `expiresAt` (end of that
    day, Nairobi time). Once it passes, the listing is removed.
  - Listings with no readable deadline are removed after a
    fallback age (Internships 45 days, Attachments 45,
    Competitions 60), counted from when they were published or
    first seen.
  The server's existing 5-minute expiry sweep and ai-updater.js
  apply the same rules to articles.json.

Routes
  GET /api/opportunities/status
  GET /api/opportunities/:type   internships | attachments | competitions

Env
  SERPER_API_KEY                required (free key: https://serper.dev)
  OPPORTUNITIES_CACHE_MINUTES   optional, default 720
=========================================================
*/

import crypto from "crypto";
import fs from "fs";
import path from "path";

const SERPER_URL = "https://google.serper.dev/search";
const MAX_PER_CATEGORY = 30;
const REQUEST_DELAY_MS = 300;

const CACHE_TIME_MS =
    Number(process.env.OPPORTUNITIES_CACHE_MINUTES || 720) * 60 * 1000;

// Keep in sync with FALLBACK_EXPIRY_DAYS in server.js and ai-updater.js
const FALLBACK_EXPIRY_DAYS = {
    Internships: 45,
    Attachments: 45,
    Competitions: 60
};

const MAX_STORED_PER_CATEGORY = 60;

const TYPES = {
    internships: {
        category: "Internships",
        queries: year => [
            `internship opportunities Kenya ${year} students apply`,
            `graduate internship programme Kenya ${year} apply now`,
            `paid internship Nairobi ${year}`
        ]
    },
    attachments: {
        category: "Attachments",
        queries: year => [
            `industrial attachment opportunities Kenya ${year}`,
            `attachment vacancies Kenya students ${year} apply`,
            `industrial attachment Nairobi ${year} application`
        ]
    },
    competitions: {
        category: "Competitions",
        queries: year => [
            `student competition Kenya ${year} apply`,
            `hackathon Kenya ${year} university students`,
            `innovation challenge Kenya students ${year} register`
        ]
    }
};

const BLOCKED_HOSTS = [
    "facebook.com", "instagram.com", "tiktok.com", "youtube.com",
    "youtu.be", "pinterest.", "reddit.com", "quora.com", "twitter.com", "x.com"
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ---------- helpers ---------- */

function hostOf(link) {
    try {
        return new URL(link).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

function isBlocked(host) {
    return !host || BLOCKED_HOSTS.some(b => host === b || host.endsWith("." + b) || host.includes(b));
}

function parseSerperDate(raw) {
    if (!raw) return "";
    const text = String(raw);

    const rel = text.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i);
    if (rel) {
        const unit = {
            minute: 6e4, hour: 36e5, day: 864e5,
            week: 6048e5, month: 2592e6, year: 31536e6
        }[rel[2].toLowerCase()];
        return new Date(Date.now() - Number(rel[1]) * unit).toISOString();
    }

    const t = Date.parse(text);
    return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

function linkKey(link) {
    try {
        const u = new URL(link);
        return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/+$/, "").toLowerCase();
    } catch {
        return String(link).toLowerCase();
    }
}

const MONTH_NAMES = [
    "january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december"
];
const MONTH_PATTERN =
    "january|february|march|april|may|june|july|august|september|october|november|december|" +
    "jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

function monthIndex(name) {
    const n = String(name).toLowerCase();
    return MONTH_NAMES.findIndex(m => m.startsWith(n.slice(0, 3)));
}

const DEADLINE_KEY =
    "(?:deadline|closing\\s+date|closes?(?:\\s+on)?|apply\\s+(?:by|before)|submit\\s+(?:by|before)|" +
    "applications?\\s+(?:close|end|open\\s+until)|on\\s+or\\s+before|not\\s+later\\s+than|due)";
const FILLER = "[^\\d\\n]{0,35}?";

const DEADLINE_PATTERNS = [
    // 30th October 2026
    { re: new RegExp(`${DEADLINE_KEY}${FILLER}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})\\.?,?\\s*(\\d{4})?`, "i"), order: "dmy" },
    // October 30, 2026
    { re: new RegExp(`${DEADLINE_KEY}${FILLER}(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?`, "i"), order: "mdy" },
    // 30/10/2026 (day first)
    { re: new RegExp(`${DEADLINE_KEY}${FILLER}(\\d{1,2})[\\/.\\-](\\d{1,2})[\\/.\\-](\\d{4})`, "i"), order: "num" }
];

const ENDED_PATTERN =
    /(applications?\s+(?:are\s+|is\s+|have\s+)?closed|no\s+longer\s+(?:accepting|open)|(?:has|have)\s+(?:expired|closed)|deadline\s+(?:has\s+)?passed|\bexpired\b)/i;

const pad = n => String(n).padStart(2, "0");

/* Returns "YYYY-MM-DD" (Nairobi calendar date) or "" if no usable date */
function extractDeadline(text) {
    const source = String(text || "");
    let best = null;

    for (const { re, order } of DEADLINE_PATTERNS) {
        const m = source.match(re);
        if (!m || (best && m.index >= best.index)) continue;

        let day, month, year;
        if (order === "dmy") { day = +m[1]; month = monthIndex(m[2]); year = m[3] ? +m[3] : null; }
        else if (order === "mdy") { month = monthIndex(m[1]); day = +m[2]; year = m[3] ? +m[3] : null; }
        else { day = +m[1]; month = +m[2] - 1; year = +m[3]; }

        best = { index: m.index, day, month, year };
    }

    if (!best || best.month < 0 || best.month > 11 || best.day < 1 || best.day > 31) return "";

    const year = best.year || new Date().getFullYear();
    const d = new Date(Date.UTC(year, best.month, best.day));
    if (d.getUTCMonth() !== best.month || d.getUTCDate() !== best.day) return "";

    // ignore obviously wrong dates (more than ~18 months away)
    if (d.getTime() - Date.now() > 540 * 864e5) return "";

    return `${year}-${pad(best.month + 1)}-${pad(best.day)}`;
}

function expiryOf(deadline) {
    return deadline ? `${deadline}T23:59:59+03:00` : null;
}

function isEnded(article, now = new Date()) {
    const explicit = article.expiresAt || article.deadline;
    if (explicit) {
        const d = new Date(explicit.length === 10 ? expiryOf(explicit) : explicit);
        if (!Number.isNaN(d.getTime())) return d < now;
    }

    const days = FALLBACK_EXPIRY_DAYS[article.category];
    const ref = new Date(article.date || article.firstSeen || article.publishedDate || 0);
    if (!days || Number.isNaN(ref.getTime()) || ref.getTime() === 0) return false;

    return (now - ref) / 864e5 > days;
}

function normalize(item, category) {
    const link = String(item.link || "").trim();
    const title = String(item.title || "").trim();
    const snippet = String(item.snippet || "").trim();
    const host = hostOf(link);

    if (!link || !title || isBlocked(host)) return null;
    if (ENDED_PATTERN.test(`${title} ${snippet}`)) return null;

    const deadline = extractDeadline(`${title}. ${snippet}`);
    const nowIso = new Date().toISOString();
    const published = parseSerperDate(item.date);

    const article = {
        id: crypto.createHash("sha1").update(linkKey(link)).digest("hex").slice(0, 16),
        title,
        summary: snippet || title,
        description: snippet || title,
        content: snippet
            ? `${snippet}\n\nThis listing was found through a web search. Open the official source below for full details and how to apply.`
            : "Open the official source below for full details and how to apply.",
        category,
        organization: host,
        url: link,
        sourceUrl: link,
        externalLink: link,
        firstSeen: nowIso,
        date: published || nowIso,
        publishedDate: published || nowIso,
        lastChecked: nowIso,
        deadline: deadline || null,
        expiresAt: expiryOf(deadline)
    };

    // Deadline already passed -> the opportunity has ended, don't save it
    return isEnded(article) ? null : article;
}

/* ---------- Serper ---------- */

async function serperSearch(query, tbs) {
    const response = await fetch(SERPER_URL, {
        method: "POST",
        headers: {
            "X-API-KEY": process.env.SERPER_API_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ke", hl: "en", num: 10, tbs }),
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        let detail = "";
        try { detail = (await response.json()).message || ""; } catch { /* ignore */ }
        throw new Error(`Serper returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const data = await response.json();
    return Array.isArray(data.organic) ? data.organic : [];
}

async function runPass(queries, tbs, category) {
    const lists = [];
    let failures = 0;
    let lastError = null;

    for (const q of queries) {
        try {
            const organic = await serperSearch(q, tbs);
            lists.push(organic.map(item => normalize(item, category)).filter(Boolean));
        } catch (error) {
            failures++;
            lastError = error;
            console.error(`Opportunities search failed: "${q}"`, error.message);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    if (failures === queries.length) throw lastError;
    return lists;
}

/* take results round-robin so one query can't dominate, then de-duplicate */
function mergeLists(lists) {
    const out = [];
    const seenLinks = new Set();
    const seenTitles = new Set();
    const longest = Math.max(0, ...lists.map(l => l.length));

    for (let i = 0; i < longest; i++) {
        for (const list of lists) {
            const item = list[i];
            if (!item) continue;
            const lk = linkKey(item.externalLink);
            const tk = item.title.toLowerCase().replace(/\W+/g, " ").trim();
            if (seenLinks.has(lk) || seenTitles.has(tk)) continue;
            seenLinks.add(lk);
            seenTitles.add(tk);
            out.push(item);
        }
    }
    return out;
}

async function sweep(type) {
    const { category, queries } = TYPES[type];
    const q = queries(new Date().getFullYear());

    // Prefer the last month; widen to the last year only if that's thin.
    let articles = mergeLists(await runPass(q, "qdr:m", category));

    if (articles.length < 6) {
        articles = mergeLists([
            articles,
            ...(await runPass(q, "qdr:y", category))
        ]);
    }

    return articles.slice(0, MAX_PER_CATEGORY);
}

/* ---------- storage, refresh, routes ---------- */

export function registerOpportunitiesRoutes(app, { dataFolder, readArticles, writeArticles } = {}) {

    const cacheFile = dataFolder
        ? path.join(dataFolder, "opportunities-cache.json")
        : null;

    const cache = {};
    const inFlight = {};

    if (cacheFile) {
        try {
            Object.assign(cache, JSON.parse(fs.readFileSync(cacheFile, "utf8")));
        } catch { /* first run or unreadable - start empty */ }
    }

    function persistCache() {
        if (!cacheFile) return;
        try {
            fs.mkdirSync(dataFolder, { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
        } catch (error) {
            console.error("Unable to save opportunities cache:", error.message);
        }
    }

    const isStale = type =>
        !cache[type] || Date.now() - (cache[type].updatedAt || 0) >= CACHE_TIME_MS;

    const newestFirst = (a, b) =>
        new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();

    /*
    Writes this category's saved items into articles.json, keeping every
    other category untouched, dropping ended items. Safe to call any time:
    it also repairs the store if another process overwrote it.
    */
    function syncStore(type, fresh = []) {
        const { category } = TYPES[type];
        const now = new Date();

        const store = readArticles ? readArticles() : [];
        const others = store.filter(a => a.category !== category);

        const merged = new Map();
        const add = (item, isFresh) => {
            const previous = merged.get(item.id);
            merged.set(item.id, previous
                ? {
                    ...previous,
                    ...item,
                    firstSeen: previous.firstSeen || item.firstSeen,
                    // keep the earliest known date so age-based expiry isn't reset
                    date: isFresh && !item.publishedDate ? previous.date : (item.date || previous.date),
                    publishedDate: previous.publishedDate || item.publishedDate
                }
                : item);
        };

        (cache[type]?.articles || []).forEach(a => add(a, false));
        store.filter(a => a.category === category).forEach(a => add(a, false));
        fresh.forEach(a => add(a, true));

        const before = merged.size;
        const mine = Array.from(merged.values())
            .filter(a => !isEnded(a, now))
            .sort(newestFirst)
            .slice(0, MAX_STORED_PER_CATEGORY);

        if (writeArticles) {
            writeArticles([...others, ...mine]);
        }

        cache[type] = { articles: mine, updatedAt: cache[type]?.updatedAt || 0 };
        persistCache();

        if (before !== mine.length) {
            console.log(`Opportunities (${category}): ${before - mine.length} ended/expired removed, ${mine.length} saved.`);
        }
        return mine;
    }

    function refresh(type) {
        if (!inFlight[type]) {
            inFlight[type] = sweep(type)
                .then(fresh => {
                    const mine = syncStore(type, fresh);
                    cache[type].updatedAt = Date.now();
                    persistCache();
                    if (!fresh.length) console.warn(`Opportunities: no new results for ${type}.`);
                    return mine;
                })
                .finally(() => { inFlight[type] = null; });
        }
        return inFlight[type];
    }

    /* Background timer: refresh stale categories, prune ended ones */
    async function tick() {
        for (const type of Object.keys(TYPES)) {
            try {
                if (process.env.SERPER_API_KEY && isStale(type)) await refresh(type);
                else syncStore(type);
            } catch (error) {
                console.error(`Opportunities refresh failed (${type}):`, error.message);
            }
            await sleep(1000);
        }
    }

    if (process.env.SERPER_API_KEY) {
        setTimeout(tick, 20 * 1000).unref?.();
        setInterval(tick, 30 * 60 * 1000).unref?.();
    }

    app.get("/api/opportunities/status", (req, res) => {
        res.json({
            configured: Boolean(process.env.SERPER_API_KEY),
            provider: "Serper.dev (Google Search)",
            groqUsed: false,
            cacheMinutes: CACHE_TIME_MS / 60000,
            cached: Object.fromEntries(
                Object.keys(TYPES).map(t => [t, {
                    articles: cache[t]?.articles?.length || 0,
                    updatedAt: cache[t]?.updatedAt || null
                }])
            )
        });
    });

    app.get("/api/opportunities/:type", async (req, res) => {
        const type = String(req.params.type || "").toLowerCase();

        if (!TYPES[type]) {
            return res.status(404).json({ success: false, error: "Unknown category.", articles: [] });
        }

        const respond = (articles, extra = {}) => res.json({
            success: true,
            category: TYPES[type].category,
            country: "Kenya",
            count: articles.length,
            updatedAt: cache[type]?.updatedAt || null,
            articles,
            ...extra
        });

        try {
            // Drop ended items and repair the store on every visit (no API cost)
            let articles = syncStore(type);

            if (!process.env.SERPER_API_KEY && !articles.length) {
                return res.status(500).json({
                    success: false,
                    error: "Not configured. Add SERPER_API_KEY to your .env file.",
                    articles: []
                });
            }

            if (process.env.SERPER_API_KEY && isStale(type)) {
                if (articles.length) {
                    // show what's saved now, refresh in the background
                    refresh(type).catch(e => console.error(`Opportunities refresh failed (${type}):`, e.message));
                } else {
                    articles = await refresh(type);
                }
            }

            respond(articles);
        } catch (error) {
            console.error(`Opportunities error (${type}):`, error.message);

            const saved = cache[type]?.articles || [];
            if (saved.length) return respond(saved, { stale: true });

            res.status(502).json({
                success: false,
                error: `Could not load ${TYPES[type].category.toLowerCase()} right now (${error.message}).`,
                articles: []
            });
        }
    });
}