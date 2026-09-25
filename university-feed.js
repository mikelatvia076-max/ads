import fs from "fs";
import path from "path";
import crypto from "crypto";

/*
=========================================================
MY CAMPUS — PER-UNIVERSITY NEWS, ANNOUNCEMENTS & OPPORTUNITIES
=========================================================

This module powers the "My Campus" picker on the homepage with
REAL, live-fetched articles for the specific institution the
student selects — not AI-generated text.

It is intentionally a NEW provider, not reused from elsewhere in
this codebase:

  - ai-updater.js already uses OpenAI, Groq, Gemini, Perplexity,
    Cohere, Exa, Cerebras and Tavily (all LLMs, none of them a
    plain news API).
  - server.js already uses NewsData.io for the nationwide
    "University Rumours" / "University Alerts" sweep.
  - opportunities.js already uses Serper.dev for Internships /
    Attachments / Competitions.

So this module talks to GNews (https://gnews.io) instead — a
straightforward search-based news API, not an AI/chat provider,
and not already used anywhere else in this project. Groq keeps
doing whatever it already does elsewhere; this feature just
doesn't touch it.

Set GNEWS_API_KEY in your .env to enable this feature. Free-tier
signup: https://gnews.io/register

Frontend calls (see public/university-feed-widget.js):

  GET /api/university-feed/institutions
  GET /api/university-feed/:id
  GET /api/university-feed/status

=========================================================
*/

const GNEWS_API_KEY =
    process.env.GNEWS_API_KEY;

const GNEWS_SEARCH_URL =
    "https://gnews.io/api/v4/search";

// How long a given institution's fetched results are reused before
// a fresh GNews sweep is triggered again. Kept generous (default 6
// hours) so the free-tier daily request quota (100/day on GNews'
// free plan) comfortably covers every institution being browsed
// throughout the day without hammering the API on every visit.
const UNIVERSITY_FEED_CACHE_MS =
    Number(
        process.env.UNIVERSITY_FEED_CACHE_MINUTES || 360
    ) *
    60 *
    1000;

// Small pause between the 3 category requests made for a single
// institution (news / announcements / opportunities), so a single
// visitor's request never bursts 3 calls at once against GNews.
const GNEWS_REQUEST_DELAY_MS = 350;

function sleep(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


/*
=========================================================
SUPPORTED INSTITUTIONS
=========================================================

Covers every currently CUE-accredited university in Kenya —
public chartered, public specialized, private chartered, and
public university constituent colleges — not just a hand-picked
handful. TVETs and mid-level colleges are a separate, later
addition (they need a different regulator's list and their own
search-term shaping); this pass is universities only.

Source: Commission for University Education (CUE) accredited
universities register.

Each entry's "query" is the search term(s) sent to GNews.
Well-known institutions get an OR'd abbreviation (e.g. JKUAT,
USIU) alongside the full name, since that's how they're
actually referred to in real news coverage — using only the
formal name would miss most real articles about them.

The frontend #myCampusSelect dropdown is populated FROM this
list at runtime (see university-feed-widget.js), so adding an
institution here is the only step needed to make it pickable.
=========================================================
*/

function slugify(name) {

    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-+|-+$)/g, "");
}

function institution(name, queryOverride) {

    return {
        id: slugify(name),
        name,
        query: queryOverride || `"${name}"`
    };
}

export const UNIVERSITY_FEED_INSTITUTIONS = [

    // ---------- Public chartered universities (36) ----------
    institution("University of Nairobi", "\"University of Nairobi\" OR UoN"),
    institution("Moi University"),
    institution("Kenyatta University"),
    institution("Egerton University"),
    institution(
        "Jomo Kenyatta University of Agriculture and Technology",
        "JKUAT OR \"Jomo Kenyatta University\""
    ),
    institution("Maseno University"),
    institution(
        "Masinde Muliro University of Science and Technology",
        "\"Masinde Muliro University\" OR MMUST"
    ),
    institution("Dedan Kimathi University of Technology", "\"Dedan Kimathi University\" OR DeKUT"),
    institution("Chuka University"),
    institution("Technical University of Kenya", "\"Technical University of Kenya\" OR TUK"),
    institution("Technical University of Mombasa", "\"Technical University of Mombasa\" OR TUM"),
    institution("Pwani University"),
    institution("Kisii University"),
    institution("University of Eldoret"),
    institution("Maasai Mara University"),
    institution(
        "Jaramogi Oginga Odinga University of Science and Technology",
        "JOOUST OR \"Jaramogi Oginga Odinga University\""
    ),
    institution("Laikipia University"),
    institution("South Eastern Kenya University", "\"South Eastern Kenya University\" OR SEKU"),
    institution("Meru University of Science and Technology", "\"Meru University\" OR MUST"),
    institution("Multimedia University of Kenya", "\"Multimedia University\" OR MMU"),
    institution("University of Kabianga"),
    institution("Karatina University"),
    institution("Kibabii University"),
    institution("Rongo University"),
    institution("The Co-operative University of Kenya", "\"Co-operative University of Kenya\""),
    institution("Taita Taveta University"),
    institution("Murang'a University of Technology", "\"Murang'a University\""),
    institution("University of Embu"),
    institution("Machakos University"),
    institution("Kirinyaga University"),
    institution("Garissa University"),
    institution("Alupe University"),
    institution("Kaimosi Friends University"),
    institution("Tom Mboya University"),
    institution("Tharaka University"),
    institution("Bomet University"),

    // ---------- Public specialized universities (4) ----------
    institution("National Defence University-Kenya", "\"National Defence University\" Kenya"),
    institution("Open University of Kenya"),
    institution("National Intelligence Research University"),
    institution(
        "Kenya Advanced Institute of Science and Technology",
        "KAIST Kenya"
    ),

    // ---------- Private chartered universities (32) ----------
    institution("University of Eastern Africa, Baraton", "\"University of Eastern Africa, Baraton\" OR Baraton"),
    institution("Catholic University of Eastern Africa", "\"Catholic University of Eastern Africa\" OR CUEA"),
    institution("Daystar University"),
    institution("Scott Christian University"),
    institution(
        "United States International University Africa",
        "\"USIU-Africa\" OR \"United States International University\""
    ),
    institution("Africa Nazarene University"),
    institution("Kenya Methodist University", "\"Kenya Methodist University\" OR KeMU"),
    institution("St. Paul's University"),
    institution("Pan Africa Christian University"),
    institution("Strathmore University"),
    institution("Kabarak University"),
    institution("Mount Kenya University", "\"Mount Kenya University\" OR MKU"),
    institution("Africa International University"),
    institution("Kenya Highlands Evangelical University"),
    institution("Great Lakes University of Kisumu"),
    institution("KCA University"),
    institution("Adventist University of Africa"),
    institution("KAG EAST University"),
    institution("Umma University"),
    institution("Presbyterian University of East Africa"),
    institution("Aga Khan University"),
    institution("Kiriri Women's University of Science and Technology"),
    institution("The East African University"),
    institution("Zetech University"),
    institution("Lukenya University"),
    institution("Management University of Africa"),
    institution("Tangaza University"),
    institution("Islamic University of Kenya"),
    institution("Riara University"),
    institution("Uzima University"),
    institution("Gretsa University"),
    institution("Amref International University"),

    // ---------- Public university constituent colleges (6) ----------
    institution("Turkana University College"),
    institution("Mama Ngina University College"),
    institution("Koitalel Arap Samoei University College"),
    institution("Nyandarua University College"),
    institution("Kabarnet University College"),
    institution("Makueni University College")
];

function findInstitution(id) {

    return UNIVERSITY_FEED_INSTITUTIONS.find(
        institution => institution.id === String(id || "").toLowerCase()
    ) || null;
}


/*
=========================================================
SEARCH QUERY GROUPS
=========================================================

Each institution is swept for 3 separate categories so the
homepage can show them as distinct sections, all sourced from
real published articles rather than a single generic feed.
=========================================================
*/

const FEED_CATEGORIES = [
    {
        key: "news",
        label: "News",
        buildQuery: institution => institution.query
    },
    {
        key: "announcements",
        label: "Announcements",
        buildQuery: institution =>
            `${institution.query} (admission OR intake OR reopening OR semester OR exam OR senate OR notice OR circular)`
    },
    {
        key: "opportunities",
        label: "Opportunities",
        buildQuery: institution =>
            `${institution.query} (scholarship OR internship OR job OR attachment OR vacancy OR fellowship OR grant)`
    }
];


/*
=========================================================
FETCH ONE GNEWS SEARCH
=========================================================
*/

async function fetchGNewsSearch(query) {

    if (!GNEWS_API_KEY) {

        throw new Error(
            "GNEWS_API_KEY is missing from .env"
        );
    }

    const url =
        `${GNEWS_SEARCH_URL}` +
        `?q=${encodeURIComponent(query)}` +
        `&lang=en` +
        `&max=6` +
        `&apikey=${encodeURIComponent(GNEWS_API_KEY)}`;

    const response =
        await fetch(url);

    if (!response.ok) {

        let detail = "";

        try {

            const errorBody = await response.json();

            detail =
                errorBody.errors?.join?.(", ") ||
                errorBody.message ||
                JSON.stringify(errorBody);

        } catch {

            try {

                detail = await response.text();

            } catch {

                // no body to read
            }
        }

        throw new Error(
            `GNews request failed with status ${response.status}` +
            (detail ? `: ${detail}` : "")
        );
    }

    const data = await response.json();

    if (!Array.isArray(data.articles)) {

        return [];
    }

    return data.articles;
}


/*
=========================================================
NORMALIZE ARTICLE
=========================================================
*/

function makeFeedHash(title, url) {

    return crypto
        .createHash("sha256")
        .update(`${title || ""}|${url || ""}`)
        .digest("hex")
        .substring(0, 16);
}

function shortenText(text, maxLength) {

    const cleaned =
        String(text || "")
            .replace(/\s+/g, " ")
            .trim();

    if (cleaned.length <= maxLength) {

        return cleaned;
    }

    return cleaned.substring(0, maxLength).trim() + "...";
}

function normalizeGNewsArticle(article, institution, categoryKey, categoryLabel) {

    const url = article.url || "";
    const title = article.title || "University update";
    const description = article.description || article.content || "";

    return {

        id: makeFeedHash(title, url) || crypto.randomUUID(),

        title,

        summary: shortenText(description, 220),

        description,

        sourceUrl: url,

        image: article.image || "",

        source: article.source?.name || "News source",

        date: article.publishedAt || new Date().toISOString(),

        category: categoryLabel,

        categoryKey,

        institutionId: institution.id,

        institutionName: institution.name,

        type: "university-feed"
    };
}


/*
=========================================================
CACHE
(persisted to disk so a server restart doesn't throw away
today's results and immediately re-burn GNews quota re-
fetching every institution again)
=========================================================
*/

function getCacheFile(dataFolder) {

    return path.join(dataFolder, "university-feed-cache.json");
}

function loadCacheFromDisk(dataFolder) {

    try {

        const file = getCacheFile(dataFolder);

        if (!fs.existsSync(file)) return {};

        const raw = fs.readFileSync(file, "utf8");

        if (!raw.trim()) return {};

        const data = JSON.parse(raw);

        return (data && typeof data === "object") ? data : {};

    } catch (error) {

        console.error("Unable to read university-feed-cache.json:", error.message);
        return {};
    }
}

function saveCacheToDisk(dataFolder, cache) {

    try {

        fs.mkdirSync(dataFolder, { recursive: true });

        fs.writeFileSync(
            getCacheFile(dataFolder),
            JSON.stringify(cache, null, 2),
            "utf8"
        );

    } catch (error) {

        console.error("Unable to write university-feed-cache.json:", error.message);
    }
}


/*
=========================================================
SWEEP ONE INSTITUTION
=========================================================
*/

function buildEmptyFeed() {

    return { news: [], announcements: [], opportunities: [], updatedAt: 0 };
}

async function sweepInstitution(institution) {

    const feed = buildEmptyFeed();

    for (const category of FEED_CATEGORIES) {

        try {

            const query = category.buildQuery(institution);

            const rawArticles = await fetchGNewsSearch(query);

            feed[category.key] = rawArticles.map(
                article =>
                    normalizeGNewsArticle(
                        article,
                        institution,
                        category.key,
                        category.label
                    )
            );

        } catch (error) {

            console.error(
                `University feed search failed (${institution.name} / ${category.label}):`,
                error.message
            );

            feed[category.key] = [];
        }

        await sleep(GNEWS_REQUEST_DELAY_MS);
    }

    feed.updatedAt = Date.now();

    return feed;
}


/*
=========================================================
PUBLIC LOADER
(in-flight de-dupe so two visitors picking the same
institution right as the cache expires don't trigger two
simultaneous GNews sweeps)
=========================================================
*/

export function createUniversityFeedStore(dataFolder) {

    const memoryCache = loadCacheFromDisk(dataFolder);

    const inFlight = new Map();

    async function loadFeed(institutionId, options = {}) {

        const institution = findInstitution(institutionId);

        if (!institution) return null;

        const cached = memoryCache[institution.id];

        const cacheAge =
            Date.now() - (cached?.updatedAt || 0);

        if (
            !options.forceFresh &&
            cached &&
            cacheAge < UNIVERSITY_FEED_CACHE_MS
        ) {

            return cached;
        }

        if (inFlight.has(institution.id)) {

            return inFlight.get(institution.id);
        }

        const sweepPromise =
            sweepInstitution(institution)
                .then(feed => {

                    memoryCache[institution.id] = feed;
                    saveCacheToDisk(dataFolder, memoryCache);

                    return feed;
                })
                .finally(() => {

                    inFlight.delete(institution.id);
                });

        inFlight.set(institution.id, sweepPromise);

        return sweepPromise;
    }

    return { loadFeed, memoryCache };
}


/*
=========================================================
ROUTES
=========================================================
*/

export function registerUniversityFeedRoutes(app, { dataFolder }) {

    const store = createUniversityFeedStore(dataFolder);

    app.get("/api/university-feed/institutions", (req, res) => {

        res.json({

            success: true,

            institutions: UNIVERSITY_FEED_INSTITUTIONS.map(
                ({ id, name }) => ({ id, name })
            )
        });
    });

    app.get("/api/university-feed/status", (req, res) => {

        res.json({

            configured: Boolean(GNEWS_API_KEY),

            provider: "GNews",

            groqUsed: false,

            institutions: UNIVERSITY_FEED_INSTITUTIONS.length,

            status: GNEWS_API_KEY ? "ready" : "not-configured"
        });
    });

    app.get("/api/university-feed/:id", async (req, res) => {

        try {

            if (!GNEWS_API_KEY) {

                return res.status(500).json({

                    success: false,

                    error: "University feed API is not configured. Add GNEWS_API_KEY to your .env file."
                });
            }

            const institution = findInstitution(req.params.id);

            if (!institution) {

                return res.status(404).json({

                    success: false,

                    error: `Unknown institution "${req.params.id}".`
                });
            }

            const forceFresh =
                req.query.refresh === "true" || req.query.refresh === "1";

            const feed = await store.loadFeed(institution.id, { forceFresh });

            res.json({

                success: true,

                institution: { id: institution.id, name: institution.name },

                news: feed.news,

                announcements: feed.announcements,

                opportunities: feed.opportunities,

                updatedAt: feed.updatedAt
            });

        } catch (error) {

            console.error("University feed API error:", error);

            res.status(500).json({

                success: false,

                error: "Unable to load this institution's feed right now.",

                news: [],
                announcements: [],
                opportunities: []
            });
        }
    });
}