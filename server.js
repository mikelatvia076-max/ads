import "dotenv/config";

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

import Groq from "groq-sdk";
import multer from "multer";
import mammoth from "mammoth";
import http from "http";
import os from "os";
import { nanoid } from "nanoid";
import { Server as SocketIOServer } from "socket.io";

/*
=========================================================
CRASH SAFETY NET
=========================================================
Without these, a single bad request could take the ENTIRE
server down for every user at once - not just fail that one
request. A file parsing or AI library can occasionally reject
or throw asynchronously from deep inside its own internals,
outside the call that is actually awaited and try/caught in
the route below. Node treats an uncaught exception or an
unhandled promise rejection anywhere in the process as fatal
by default and exits - which looks like "the server crashed"
from outside, even though only one request was ever a problem.

These two handlers turn that from "the whole app goes down"
into "log it and keep serving everyone else". This is a
safety net, not a fix for the underlying bug - if something
keeps hitting this, the console output tells you what/where.
*/

process.on(
    "uncaughtException",
    (error) => {

        console.error(
            "UNCAUGHT EXCEPTION (server stayed up):",
            error
        );
    }
);

process.on(
    "unhandledRejection",
    (reason) => {

        console.error(
            "UNHANDLED PROMISE REJECTION (server stayed up):",
            reason
        );
    }
);



/*
=========================================================
KENYA CAMPUS HUB
MAIN SERVER
=========================================================
*/

const app = express();

// Wrap the Express app in a raw HTTP server so Socket.io (used by the
// chat feature below) can attach to the same server and port.
const server = http.createServer(app);

const io = new SocketIOServer(server, {
    maxHttpBufferSize: 25 * 1024 * 1024 // allow larger payloads for chat previews
});

const PORT =
    Number(process.env.PORT) || 3000;

const UPDATE_INTERVAL =
    Number(
        process.env.UPDATE_INTERVAL_MINUTES || 180
    );


/*
=========================================================
GROQ AI
=========================================================
*/

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const GROQ_MODEL =
    process.env.GROQ_MODEL ||
    "openai/gpt-oss-120b";


/*
=========================================================
PATHS
=========================================================
*/

const __filename =
    fileURLToPath(import.meta.url);

const __dirname =
    path.dirname(__filename);

const publicFolder =
    path.join(
        __dirname,
        "public"
    );

const dataFolder =
    path.join(
        __dirname,
        "data"
    );

const articlesFile =
    path.join(
        dataFolder,
        "articles.json"
    );

// NOTE: On Vercel (and most serverless platforms) the deployed project
// files, including everything under "public/", are read-only at runtime.
// The only writable location is the OS temp directory. Files written here
// are NOT persistent - they can disappear whenever the serverless
// instance recycles. This unblocks the crash; for uploads that need to
// survive across requests/deploys, switch to a persistent store like
// Vercel Blob, S3, or Cloudinary instead.
const chatUploadsFolder =
    path.join(
        os.tmpdir(),
        "uploads"
    );

// Best-effort email → name lookup, so a returning visitor who forgets
// which name they used can look it up by the email they signed in
// with. This lives in the OS temp dir for the same reason uploads do:
// it's the only writable location on serverless platforms like
// Vercel. It is NOT durable storage — a recycled serverless instance
// can lose it — but it survives for as long as a given server
// process/instance is alive, which is enough to be genuinely useful
// without standing up a real database.
const usersRegistryFile =
    path.join(
        os.tmpdir(),
        "site-chat-users.json"
    );

function readUsersRegistry() {

    try {

        if (!fs.existsSync(usersRegistryFile)) return {};

        const raw = fs.readFileSync(usersRegistryFile, "utf8");

        if (!raw.trim()) return {};

        const data = JSON.parse(raw);

        return (data && typeof data === "object") ? data : {};

    } catch (error) {

        console.error("Unable to read users registry:", error.message);
        return {};
    }
}

function writeUsersRegistry(registry) {

    try {

        fs.writeFileSync(
            usersRegistryFile,
            JSON.stringify(registry, null, 2),
            "utf8"
        );

    } catch (error) {

        console.error("Unable to write users registry:", error.message);
    }
}

function rememberUserEmail(name, email) {

    if (!email) return;

    const emailKey = String(email).trim().toLowerCase();

    if (!emailKey) return;

    const registry = readUsersRegistry();

    registry[emailKey] = { name, updatedAt: Date.now() };

    writeUsersRegistry(registry);
}

function lookupNameByEmail(email) {

    const emailKey = String(email || "").trim().toLowerCase();

    if (!emailKey) return null;

    const registry = readUsersRegistry();
    const entry = registry[emailKey];

    return entry ? entry.name : null;
}


/*
=========================================================
CHAT HISTORY STORE
(persists every 1:1 conversation to disk so it survives a
refresh/reconnect - "where you reached" - plus a per-
conversation disappearing-messages setting. Lives in the OS
temp dir for the same reason the users registry does: it's
the only writable location on serverless platforms, and it
survives for as long as the server process stays alive,
which is enough to be genuinely useful without a real DB.)
=========================================================
*/

const chatHistoryFile =
    path.join(
        os.tmpdir(),
        "site-chat-history.json"
    );

// how many messages to keep per conversation before trimming the
// oldest ones off, so the store can't grow forever
const MAX_STORED_MESSAGES_PER_CONVO = 500;

// only these durations (in seconds) are accepted for disappearing
// messages; 0 means "off"
const ALLOWED_DISAPPEARING_SECONDS = [0, 86400, 604800, 7776000];

function readChatHistoryStore() {

    try {

        if (!fs.existsSync(chatHistoryFile)) return {};

        const raw = fs.readFileSync(chatHistoryFile, "utf8");

        if (!raw.trim()) return {};

        const data = JSON.parse(raw);

        return (data && typeof data === "object") ? data : {};

    } catch (error) {

        console.error("Unable to read chat history store:", error.message);
        return {};
    }
}

function writeChatHistoryStore(store) {

    try {

        fs.writeFileSync(
            chatHistoryFile,
            JSON.stringify(store),
            "utf8"
        );

    } catch (error) {

        console.error("Unable to write chat history store:", error.message);
    }
}

// a conversation between two user keys always gets the same id no
// matter who looks it up, by sorting the two ids
function conversationKey(a, b) {

    return [String(a), String(b)].sort().join("::");
}

function getOrCreateConversation(store, key) {

    if (!store[key]) {

        store[key] = {
            messages: [],
            disappearing: { enabled: false, seconds: 0 },
            lastRead: {}
        };
    }

    // guard against a store written before one of these fields existed
    if (!store[key].disappearing) store[key].disappearing = { enabled: false, seconds: 0 };
    if (!store[key].lastRead) store[key].lastRead = {};

    return store[key];
}

// drops messages whose disappearing timer has expired; returns the
// ids removed, per conversation key, so callers can tell still-
// connected clients to remove them too
function pruneExpiredMessages(store) {

    const now = Date.now();
    const removedByKey = {};

    for (const key of Object.keys(store)) {

        const convo = store[key];
        if (!convo || !Array.isArray(convo.messages)) continue;

        const kept = [];
        const removed = [];

        for (const msg of convo.messages) {

            if (msg.expiresAt && msg.expiresAt <= now) {
                removed.push(msg.id);
            } else {
                kept.push(msg);
            }
        }

        if (removed.length) {
            convo.messages = kept;
            removedByKey[key] = removed;
        }
    }

    return removedByKey;
}

function saveChatMessage(fromId, toId, message) {

    const store = readChatHistoryStore();

    // a group's messages live under the group's own id (every
    // member reads/writes the same conversation), rather than a
    // per-sender-pair key like a 1:1 chat uses
    const key = isGroupId(toId) ? toId : conversationKey(fromId, toId);
    const convo = getOrCreateConversation(store, key);

    if (convo.disappearing.enabled && convo.disappearing.seconds > 0) {
        message.expiresAt = Date.now() + (convo.disappearing.seconds * 1000);
    }

    convo.messages.push(message);

    if (convo.messages.length > MAX_STORED_MESSAGES_PER_CONVO) {
        convo.messages =
            convo.messages.slice(
                convo.messages.length - MAX_STORED_MESSAGES_PER_CONVO
            );
    }

    writeChatHistoryStore(store);

    return message.expiresAt || null;
}

function removeStoredMessage(userA, userB, messageId) {

    const store = readChatHistoryStore();
    const key = isGroupId(userB) ? userB : conversationKey(userA, userB);
    const convo = getOrCreateConversation(store, key);

    convo.messages = convo.messages.filter(m => m.id !== messageId);

    writeChatHistoryStore(store);
}

try {

    fs.mkdirSync(
        chatUploadsFolder,
        { recursive: true }
    );

} catch (error) {

    console.error(
        "Could not create chat uploads folder:",
        error
    );
}


/*
=========================================================
MIDDLEWARE
=========================================================
*/

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);

app.use(
    express.static(
        publicFolder
    )
);

// Chat uploads now live outside "public/" (in the OS temp dir, since
// "public/" is read-only on serverless platforms), so they need their
// own static route to still be reachable at /uploads/<filename>.
app.use(
    "/uploads",
    express.static(
        chatUploadsFolder
    )
);


/*
=========================================================
FILE UPLOAD CONFIGURATION
=========================================================
*/

const upload =
    multer({
        storage:
            multer.memoryStorage(),

        limits: {
            fileSize:
                10 * 1024 * 1024
        },

        fileFilter:
            (req, file, callback) => {

                const allowedTypes = [

                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

                    "application/msword",

                    "text/plain",

                    "text/csv",

                    "application/json",

                    "image/png",

                    "image/jpeg",

                    "image/webp"

                ];

                if (
                    allowedTypes.includes(
                        file.mimetype
                    )
                ) {

                    callback(
                        null,
                        true
                    );

                } else {

                    callback(
                        new Error(
                            `Unsupported file type: ${file.mimetype}`
                        )
                    );
                }
            }
    });


/*
=========================================================
CHAT FILE UPLOADS
(images, videos, audio/voice notes, documents shared
in the chat feature — separate from the AI document
uploader above)
=========================================================
*/

const chatStorage =
    multer.diskStorage({
        destination:
            (req, file, cb) =>
                cb(null, chatUploadsFolder),

        filename:
            (req, file, cb) => {

                const ext =
                    path.extname(
                        file.originalname
                    ) || "";

                cb(
                    null,
                    `${Date.now()}-${nanoid(8)}${ext}`
                );
            }
    });

const chatUpload =
    multer({
        storage: chatStorage,
        limits: { fileSize: 100 * 1024 * 1024 } // 100MB cap
    });

app.post(
    "/upload",
    chatUpload.single("file"),
    (req, res) => {

        if (!req.file) {

            return res.status(400).json({
                error: "No file received"
            });
        }

        const mime = req.file.mimetype || "";
        let kind = "file";

        if (mime.startsWith("image/")) kind = "image";
        else if (mime.startsWith("video/")) kind = "video";
        else if (mime.startsWith("audio/")) kind = "audio";

        res.json({
            url: `/uploads/${req.file.filename}`,
            name: req.file.originalname,
            kind,
            mime,
            size: req.file.size
        });
    }
);


/*
=========================================================
GIF SEARCH
(proxied server-side so the API key is never exposed to
the browser; uses GIPHY's public API)
=========================================================
*/

// GIPHY's own public "beta" demo key - fine for trying this out, but
// rate-limited and NOT meant for production. Get a free key at
// https://developers.giphy.com and set GIPHY_API_KEY in your .env
// before shipping this for real.
const GIPHY_API_KEY =
    process.env.GIPHY_API_KEY || "dc6zaTOxFJmzC";

app.get(
    "/api/gifs",
    async (req, res) => {

        try {

            const q =
                String(req.query.q || "").trim();

            const limit =
                Math.min(Number(req.query.limit) || 24, 50);

            const endpoint =
                q
                    ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(q)}&limit=${limit}&rating=pg-13`
                    : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=${limit}&rating=pg-13`;

            const giphyRes =
                await fetch(endpoint);

            if (!giphyRes.ok) {

                throw new Error(
                    `GIPHY responded with ${giphyRes.status}`
                );
            }

            const data =
                await giphyRes.json();

            const gifs =
                (data.data || []).map(
                    (g) => ({
                        id: g.id,
                        preview:
                            g.images?.fixed_width_small?.url ||
                            g.images?.fixed_width?.url,
                        url:
                            g.images?.fixed_width?.url ||
                            g.images?.original?.url,
                        width:
                            Number(g.images?.fixed_width?.width) || null,
                        height:
                            Number(g.images?.fixed_width?.height) || null
                    })
                );

            res.json({ gifs });

        } catch (error) {

            console.error(
                "GIF search error:",
                error
            );

            res.status(500).json({
                error: "Unable to fetch GIFs.",
                gifs: []
            });
        }
    }
);

/*
=========================================================
UNIVERSITY RUMOURS / CAMPUS NEWS
=========================================================

IMPORTANT:

This API is ONLY for:
- University rumours
- Campus news
- Student protests
- University strikes
- University closures
- Reopening information
- Campus elections
- Student leadership
- University fees
- Accommodation
- Student welfare
- University announcements
- Campus events
- University policies
- Student demonstrations
- Academic calendar changes
- Other Kenyan university-related information

"University Alerts" (strikes/closures/protests/reopenings) is
also sourced from this same NewsData sweep now, not a separate
provider - see UNIVERSITY_RUMOUR_SEARCHES below, where each
search group is tagged with the category its results should be
stored under.

It does NOT use Groq.

The NewsData API key is kept inside .env.

Frontend calls:

GET /api/university-rumours

instead of calling NewsData directly.
=========================================================
*/

const NEWSDATA_API_KEY =
    process.env.NEWSDATA_API_KEY;


/*
=========================================================
NEWSDATA API
=========================================================
*/

const NEWSDATA_API_URL =
    "https://newsdata.io/api/1/latest";


/*
=========================================================
UNIVERSITY SEARCH TERMS
=========================================================

Grouped with NewsData's OR operator so each request covers
several near-duplicate phrasings at once, cutting down on
NewsData calls per load vs. one request per phrase.

IMPORTANT: NewsData rejects any q value over 100 characters
with a 422 ("Query length cannot be greater than 100") on
this plan - the previous comment here assumed a 512-character
limit, which is what let 3 of the original 6 groups quietly
exceed 100 chars and fail every single sweep. Every group
below is kept under 100 chars; if you add phrases to a group,
keep checking the length (e.g. with a quick
`node -e "console.log(YOUR_STRING.length)"`) rather than
trusting the old assumption.
=========================================================
*/

const NEWSDATA_REQUEST_DELAY_MS = 400;

function sleep(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );

}


/*
Each entry is tagged with the category its results get stored under.
University Alerts used to be its own AI-provider category in
ai-updater.js (Tavily search + Cerebras JSON-compose) - that second
compose step was a single point of failure (see the 402 "Cerebras
JSON-compose step failed" incident). These are exactly the
disruption-flavoured search groups that category cared about, so
they're tagged "University Alerts" here instead, and everything else
stays "University Rumours". Same NewsData sweep, same request, just
split by category on the way out.
*/
const UNIVERSITY_RUMOUR_SEARCHES = [

    {
        term: '"Kenya university" OR "Kenyan university" OR "Kenya campus" OR "Kenyan campus"',
        category: "University Rumours"
    },

    {
        term: '"university students Kenya"',
        category: "University Rumours"
    },

    {
        term: '"student protest Kenya" OR "student protests Kenya" OR "university strike Kenya"',
        category: "University Alerts"
    },

    {
        term: '"student strike Kenya" OR "campus strike Kenya" OR "campus demonstration Kenya"',
        category: "University Alerts"
    },

    {
        term: '"university students demonstration Kenya"',
        category: "University Alerts"
    },

    {
        term: '"university closure Kenya" OR "university reopening Kenya"',
        category: "University Alerts"
    },

    {
        term: '"university fees Kenya" OR "university accommodation Kenya" OR "student welfare Kenya"',
        category: "University Rumours"
    },

    {
        term: '"university election Kenya" OR "student leadership Kenya"',
        category: "University Rumours"
    },

    {
        term: '"university announcement Kenya" OR "university academic calendar Kenya" OR "university exams Kenya"',
        category: "University Rumours"
    },

    {
        term: '"university registration Kenya" OR "university policy Kenya" OR "university event Kenya"',
        category: "University Rumours"
    }

];


/*
=========================================================
NEWS CACHE
=========================================================

Caching prevents every visitor from creating many NewsData
requests at the same time.

180 minutes - matched to the same UPDATE_INTERVAL_MINUTES
the AI updater uses for every other category (default 180),
rather than the old 15 minutes. Campus news doesn't change
minute to minute, and a free-tier NewsData key can't sustain
a 6-request sweep (now grouped from 25) every 15 minutes
across multiple visitors without hitting its rate limit -
which is exactly what the "all N searches returned zero
results" log lines were.
=========================================================
*/

let universityRumoursCache = {

    articles: [],

    updatedAt: 0

};


const UNIVERSITY_RUMOURS_CACHE_TIME =
    Number(
        process.env.UPDATE_INTERVAL_MINUTES || 180
    ) *
    60 *
    1000;


/*
=========================================================
FETCH ONE NEWS SEARCH
=========================================================
*/

async function fetchUniversityNewsSearch(term) {

    if (!NEWSDATA_API_KEY) {

        throw new Error(
            "NEWSDATA_API_KEY is missing from .env"
        );

    }


    const url =
        `${NEWSDATA_API_URL}` +
        `?apikey=${encodeURIComponent(
            NEWSDATA_API_KEY
        )}` +
        `&q=${encodeURIComponent(term)}` +
        `&country=ke` +
        `&language=en` +
        `&size=10`;


    const response =
        await fetch(url);


    if (!response.ok) {

        /*
        NewsData almost always sends a JSON body explaining
        *why* the request was rejected (bad/unsupported
        parameter, plan restriction on query complexity,
        rate limit, etc). Without reading it, every failure
        just looks like "status 422" with no way to tell
        which of those it actually was - which is exactly
        what showed up in the logs. Read the body (falling
        back to raw text if it isn't JSON) so the real reason
        ends up in the console.
        */

        let detail = "";

        try {

            const errorBody =
                await response.json();

            detail =
                errorBody.results?.message ||
                errorBody.message ||
                JSON.stringify(errorBody);

        } catch {

            try {

                detail =
                    await response.text();

            } catch {

                // Ignore - no body could be read.
            }
        }

        throw new Error(
            `NewsData request failed with status ${response.status}` +
            (detail ? `: ${detail}` : "")
        );

    }


    const data =
        await response.json();


    /*
    NewsData can return an API-level error even when
    the HTTP request itself succeeded.
    */

    if (
        data.status === "error"
    ) {

        throw new Error(
            data.results?.message ||
            data.message ||
            "NewsData API returned an error."
        );

    }


    if (
        !Array.isArray(
            data.results
        )
    ) {

        return [];

    }


    return data.results;

}


/*
=========================================================
NORMALIZE NEWS ARTICLE
=========================================================

Includes both:
  - the NewsData-shaped fields (title, description, link,
    image_url, pubDate, source_name, video_url, ...) that
    the homepage rumours widget (university-rumours.js)
    reads directly, and
  - the canonical article-store fields (summary, source,
    sourceUrl, date, expiresAt, updated, lastChecked,
    sourceHash, type) shared with every other category in
    data/articles.json, so University Rumours also shows up
    through /api/content and /api/content/:category like
    HELB, KUCCPS, Jobs, Scholarships and University Alerts
    do - not just on the homepage widget.
=========================================================
*/

function normalizeUniversityRumour(
    article,
    category
) {

    const link =
        article.link ||
        "";

    const pubDate =
        article.pubDate ||
        "";

    const description =
        article.description ||
        "";

    const content =
        article.content ||
        description ||
        "";

    const sourceName =
        article.source_name ||
        article.source_id ||
        "News source";

    const nowISO =
        new Date().toISOString();

    return {

        id:
            article.article_id ||
            link ||
            nanoid(12),

        title:
            article.title ||
            "University news",

        description,

        content,

        link,

        image_url:
            article.image_url ||
            "",

        pubDate,

        source_name:
            sourceName,

        source_id:
            article.source_id ||
            "",

        source_url:
            article.source_url ||
            "",

        category:
            category ||
            "University Rumours",

        country:
            Array.isArray(article.country)
                ? article.country
                : ["Kenya"],

        language:
            article.language ||
            "english",

        keywords:
            Array.isArray(article.keywords)
                ? article.keywords
                : [],

        creator:
            Array.isArray(article.creator)
                ? article.creator
                : [],

        video_url:
            article.video_url ||
            "",

        video_id:
            article.video_id ||
            "",

        full_description:
            description ||
            content ||
            "",

        // ---------- canonical article-store fields ----------

        summary:
            shortenUniversityRumourSummary(
                description ||
                content,
                400
            ),

        source:
            sourceName,

        sourceUrl:
            link,

        date:
            pubDate ||
            nowISO,

        expiresAt:
            computeUniversityRumourExpiry(
                pubDate
            ),

        updated:
            nowISO,

        lastChecked:
            nowISO,

        sourceHash:
            makeUniversityRumourHash(
                article.title,
                link
            ),

        type:
            "news"

    };

}


// Short server-side equivalent of the client's shortenRumourText(),
// used only for the "summary" field surfaced through the shared
// /api/content endpoints (article.html, category.html, etc).
function shortenUniversityRumourSummary(
    text,
    maxLength
) {

    const cleaned =
        String(text || "")
            .replace(/\s+/g, " ")
            .trim();

    if (cleaned.length <= maxLength) {

        return cleaned;
    }

    return (
        cleaned
            .substring(0, maxLength)
            .trim() +
        "..."
    );
}


function makeUniversityRumourHash(
    title,
    url
) {

    return crypto
        .createHash("sha256")
        .update(
            `${title || ""}|${url || ""}`
        )
        .digest("hex")
        .substring(0, 16);
}


// ========================================
// EXPIRE OLD UNIVERSITY RUMOURS
// ========================================
// News-derived rumours don't come with an explicit deadline like a
// HELB/KUCCPS/scholarship announcement does, so they age out on a
// fixed shelf life from their publish date instead.

const UNIVERSITY_RUMOUR_FALLBACK_EXPIRY_DAYS = 14;

function computeUniversityRumourExpiry(
    pubDate
) {

    if (!pubDate) {

        return null;
    }

    const published =
        new Date(pubDate);

    if (isNaN(published)) {

        return null;
    }

    published.setDate(
        published.getDate() +
        UNIVERSITY_RUMOUR_FALLBACK_EXPIRY_DAYS
    );

    return published
        .toISOString()
        .split("T")[0];
}


function pruneExpiredUniversityRumours(
    articles
) {

    const now =
        new Date();

    return articles.filter(
        article => {

            const reference =
                article.expiresAt ||
                null;

            if (!reference) {

                return true;
            }

            const expiry =
                new Date(reference);

            if (isNaN(expiry)) {

                return true;
            }

            if (expiry < now) {

                console.log(
                    `University Rumours EXPIRED: ${article.title}`
                );

                return false;
            }

            return true;
        }
    );
}


/*
=========================================================
REMOVE DUPLICATE UNIVERSITY STORIES
=========================================================
*/

function removeDuplicateUniversityRumours(
    articles
) {

    const unique =
        new Map();


    for (
        const article of articles
    ) {

        const key =
            String(
                article.link ||
                article.id ||
                article.title
            )
                .trim()
                .toLowerCase();


        if (!key) {

            continue;

        }


        if (!unique.has(key)) {

            unique.set(
                key,
                article
            );

        }

    }


    return Array.from(
        unique.values()
    );

}


/*
=========================================================
SORT UNIVERSITY NEWS
=========================================================
*/

function sortUniversityRumours(
    articles
) {

    return [...articles].sort(
        (a, b) => {

            const dateA =
                new Date(
                    a.pubDate || 0
                ).getTime();


            const dateB =
                new Date(
                    b.pubDate || 0
                ).getTime();


            return dateB - dateA;

        }
    );

}


/*
=========================================================
SAVE UNIVERSITY RUMOURS TO THE SHARED ARTICLE STORE
=========================================================

Merges freshly-loaded rumours into data/articles.json
alongside every other category (HELB, KUCCPS, Jobs,
Scholarships) so:

  - a restart doesn't lose them (unlike the old in-memory-
    only cache),
  - /api/content and /api/content/university-rumours serve
    them too (not just the homepage widget), and
  - they get removed once they pass their expiresAt date.

Only the "University Rumours" and "University Alerts" slices
of the store are touched here - both are sourced from this
same NewsData sweep now (see UNIVERSITY_RUMOUR_SEARCHES),
just split by category. Every other category's articles are
left exactly as ai-updater.js wrote them.
=========================================================
*/

function writeArticles(articles) {

    try {

        fs.mkdirSync(
            dataFolder,
            { recursive: true }
        );

        fs.writeFileSync(
            articlesFile,
            JSON.stringify(
                articles,
                null,
                2
            ),
            "utf8"
        );

    } catch (error) {

        console.error(
            "Unable to write articles.json:",
            error.message
        );
    }
}


function rumourMergeKey(article) {

    return String(
        article.sourceUrl ||
        article.link ||
        article.id ||
        article.title ||
        ""
    )
        .trim()
        .toLowerCase();
}


// Categories sourced from this same NewsData sweep, split by search
// group - see UNIVERSITY_RUMOUR_SEARCHES.
const NEWSDATA_SWEEP_CATEGORIES = [
    "University Rumours",
    "University Alerts"
];

function saveUniversityRumoursToArticles(
    freshRumours
) {

    try {

        const store =
            readArticles();

        const otherCategories =
            store.filter(
                article =>
                    !NEWSDATA_SWEEP_CATEGORIES.includes(
                        article.category
                    )
            );

        const existingRumours =
            store.filter(
                article =>
                    NEWSDATA_SWEEP_CATEGORIES.includes(
                        article.category
                    )
            );

        const merged =
            new Map();

        for (
            const article of existingRumours
        ) {

            merged.set(
                rumourMergeKey(article),
                article
            );
        }

        for (
            const article of freshRumours
        ) {

            merged.set(
                rumourMergeKey(article),
                article
            );
        }

        let rumours =
            Array.from(
                merged.values()
            );

        const beforeExpiry =
            rumours.length;

        rumours =
            pruneExpiredUniversityRumours(
                rumours
            );

        const expiredCount =
            beforeExpiry -
            rumours.length;

        writeArticles([
            ...otherCategories,
            ...rumours
        ]);

        console.log(
            `University Rumours saved: ${rumours.length} ` +
            `(${expiredCount} expired & removed).`
        );

    } catch (error) {

        console.error(
            "Unable to save university rumours to articles.json:",
            error.message
        );
    }
}


/*
=========================================================
LOAD ALL UNIVERSITY RUMOURS
=========================================================

loadUniversityRumoursFromNewsData() below is the public
entry point every request calls. It's a thin guard around
runUniversityRumoursSweep() (the actual 6-request NewsData
sweep + normalize/save pipeline): if a sweep is already
running when a second request arrives - e.g. two visitors
both landing right after the cache expires - the second
request just awaits the SAME in-flight promise instead of
kicking off its own duplicate sweep. Without this, a stale
cache could get hit by several full sweeps at once, which is
exactly the kind of burst that trips NewsData's rate limit.
=========================================================
*/

let universityRumoursSweepInFlight = null;

async function loadUniversityRumoursFromNewsData() {

    const cacheAge =
        Date.now() -
        universityRumoursCache.updatedAt;

    if (
        universityRumoursCache.articles.length > 0 &&
        cacheAge <
            UNIVERSITY_RUMOURS_CACHE_TIME
    ) {

        return universityRumoursCache.articles;
    }

    if (universityRumoursSweepInFlight) {

        return universityRumoursSweepInFlight;
    }

    universityRumoursSweepInFlight =
        runUniversityRumoursSweep()
            .finally(
                () => {

                    universityRumoursSweepInFlight =
                        null;
                }
            );

    return universityRumoursSweepInFlight;
}


async function runUniversityRumoursSweep() {

    /*
    ---------------------------------------------
    CHECK API KEY
    ---------------------------------------------
    */

    if (!NEWSDATA_API_KEY) {

        throw new Error(
            "NEWSDATA_API_KEY is not configured."
        );

    }


    /*
    ---------------------------------------------
    SEARCH NEWS
    ---------------------------------------------

    IMPORTANT: these run staggered, not all at once.
    Firing all of the grouped search terms in parallel (the previous
    behavior) is exactly the kind of burst that trips a
    free-tier NewsData rate limit - when that happens every
    one of the 25 requests fails, each failure is swallowed
    by the .catch() below (by design, so one bad term
    doesn't kill the others), and the endpoint quietly
    returns success:true with an empty articles array. That
    looks like "university rumours isn't loading anything"
    with no visible error anywhere. Spacing requests out
    keeps this from happening in the first place.
    */

    const searchResults = [];

    for (
        const { term, category } of UNIVERSITY_RUMOUR_SEARCHES
    ) {

        try {

            const results =
                await fetchUniversityNewsSearch(
                    term
                );

            searchResults.push(
                { results, category }
            );

        } catch (error) {

            console.error(
                `University search failed: "${term}"`,
                error.message
            );

            searchResults.push(
                { results: [], category }
            );
        }

        await sleep(
            NEWSDATA_REQUEST_DELAY_MS
        );

    }

    const responses =
        searchResults;


    /*
    ---------------------------------------------
    COMBINE RESULTS
    ---------------------------------------------

    Each raw NewsData result is normalized here (rather than in one
    combined .map() afterward) so it can be tagged with the category
    of the search group it came from - "University Alerts" for the
    strike/closure/protest groups, "University Rumours" for everything
    else. See UNIVERSITY_RUMOUR_SEARCHES above.
    ---------------------------------------------
    */

    let articles = [];


    for (
        const { results, category } of responses
    ) {

        if (
            Array.isArray(results)
        ) {

            articles.push(
                ...results.map(
                    article =>
                        normalizeUniversityRumour(
                            article,
                            category
                        )
                )
            );

        }

    }


    /*
    ---------------------------------------------
    REMOVE DUPLICATES
    ---------------------------------------------
    */

    articles =
        removeDuplicateUniversityRumours(
            articles
        );


    /*
    ---------------------------------------------
    SORT NEWEST FIRST
    ---------------------------------------------
    */

    articles =
        sortUniversityRumours(
            articles
        );


    /*
    ---------------------------------------------
    KEEP LATEST 100
    ---------------------------------------------
    */

    articles =
        articles.slice(
            0,
            100
        );


    /*
    ---------------------------------------------
    DIAGNOSTIC: warn loudly if everything came back
    empty, so "nothing is loading" has an obvious
    cause in the server console instead of silently
    returning success:true with zero articles.
    ---------------------------------------------
    */

    if (articles.length === 0) {

        console.warn(
            "University rumours: all " +
            UNIVERSITY_RUMOUR_SEARCHES.length +
            " searches returned zero results. " +
            "Check the \"University search failed\" lines above " +
            "for the actual NewsData error (bad/missing key, " +
            "rate limit, etc.)."
        );

    }


    /*
    ---------------------------------------------
    SAVE TO SHARED ARTICLE STORE
    ---------------------------------------------
    Persist whatever was actually found this round (even if
    it's an empty array from a run where every search
    failed) so expired rumours still get pruned out on a
    quiet round, matching how every other category behaves.
    ---------------------------------------------
    */

    saveUniversityRumoursToArticles(
        articles
    );


    /*
    ---------------------------------------------
    UPDATE CACHE
    ---------------------------------------------
    */

    universityRumoursCache = {

        articles,

        updatedAt:
            Date.now()

    };


    return articles;

}


/*
=========================================================
AUTOMATIC UNIVERSITY RUMOURS UPDATER
=========================================================

Every other category (HELB, KUCCPS, Jobs, Scholarships,
University Alerts) gets refreshed on a schedule by
runUpdater()/ai-updater.js regardless of whether anyone is
visiting the site. University Rumours previously only swept
NewsData the first time a browser hit /api/university-rumours,
so on a quiet server data/articles.json could sit with zero
"University Rumours" entries indefinitely.

runUniversityRumoursAutoUpdate() below plugs it into the same
kind of schedule, in-process (it doesn't use Groq, so it has
no reason to go through the ai-updater.js child process).
loadUniversityRumoursFromNewsData() already no-ops if the
in-memory cache is still fresh and already de-dupes concurrent
sweeps, so calling this on a timer is safe even if a visitor's
own request lands around the same time.
=========================================================
*/

async function runUniversityRumoursAutoUpdate() {

    if (!NEWSDATA_API_KEY) {

        console.warn(
            "University Rumours auto-update skipped: " +
            "NEWSDATA_API_KEY is not configured."
        );

        return;
    }

    try {

        console.log(
            "University Rumours: running scheduled update..."
        );

        const articles =
            await loadUniversityRumoursFromNewsData();

        console.log(
            `University Rumours: scheduled update finished ` +
            `(${articles.length} stories cached).`
        );

    } catch (error) {

        console.error(
            "University Rumours scheduled update failed:",
            error.message
        );
    }
}


/*
=========================================================
UNIVERSITY RUMOURS API
=========================================================

Frontend:

fetch("/api/university-rumours")

=========================================================
*/

app.get(
    "/api/university-rumours",
    async (req, res) => {

        try {

            /*
            -----------------------------------------
            API KEY CHECK
            -----------------------------------------
            */

            if (
                !NEWSDATA_API_KEY
            ) {

                return res.status(500).json({

                    success: false,

                    error:
                        "University rumours API is not configured. Add NEWSDATA_API_KEY to your .env file."

                });

            }


            /*
            -----------------------------------------
            LOAD STORIES
            -----------------------------------------
            */

            const articles =
                await loadUniversityRumoursFromNewsData();


            /*
            -----------------------------------------
            RESPONSE
            -----------------------------------------
            */

            res.json({

                success: true,

                category:
                    "University Rumours",

                country:
                    "Kenya",

                count:
                    articles.length,

                updatedAt:
                    universityRumoursCache.updatedAt,

                articles

            });

        } catch (error) {

            console.error(
                "University rumours API error:",
                error
            );


            res.status(500).json({

                success: false,

                error:
                    "Unable to load university rumours right now.",

                articles: []

            });

        }

    }
);


/*
=========================================================
UNIVERSITY RUMOURS STATUS
=========================================================
*/

app.get(
    "/api/university-rumours/status",
    (req, res) => {

        res.json({

            configured:
                Boolean(
                    NEWSDATA_API_KEY
                ),

            provider:
                "NewsData.io",

            category:
                "University Rumours",

            country:
                "Kenya",

            groqUsed:
                false,

            cachedArticles:
                universityRumoursCache.articles.length,

            cacheUpdatedAt:
                universityRumoursCache.updatedAt || null,

            status:
                NEWSDATA_API_KEY
                    ? "ready"
                    : "not-configured"

        });

    }
);
/*
=========================================================
CHAT PRESENCE + SIGNALING
(text messages, file/voice-note sharing, and WebRTC
voice/video call signaling — media itself flows directly
between browsers, not through this server)
=========================================================
*/

const onlineChatUsers = new Map();

function isSafeAvatarUrl(url) {

    if (typeof url !== "string" || !url) return false;
    if (url.length > 300) return false;

    // only allow our own uploaded files or a normal http(s) image URL —
    // blocks things like javascript: URIs
    return (
        url.startsWith("/uploads/") ||
        /^https?:\/\//i.test(url)
    );
}

function broadcastChatUserList() {

    const list =
        Array.from(onlineChatUsers.entries())
            .map(([id, u]) => ({ id, name: u.name, avatar: u.avatar || null }));

    io.emit("user-list", list);
}

io.on("connection", (socket) => {

    let chatUserId = null;

    socket.on("join", (payload) => {

        // accepts either the old plain-string form or the newer
        // { name, email } shape, so older clients still work
        const isObj = payload && typeof payload === "object";

        const rawName = isObj ? payload.name : payload;
        const rawEmail = isObj ? payload.email : null;

        const safeName =
            String(rawName || "Guest").slice(0, 40).trim();

        if (!safeName) return;

        const safeEmail =
            rawEmail
                ? String(rawEmail).slice(0, 120).trim()
                : null;

        // Identity is derived from the name itself (not the raw
        // socket.id, which changes on every reconnect). That way
        // rejoining with the same name after a refresh/disconnect
        // keeps the same id, so the other person's saved friend
        // entry still points at the right person and their chat
        // history/friend list keeps working.
        const userKey = safeName.toLowerCase();

        if (onlineChatUsers.has(userKey)) {
            // Someone else is already online under this exact name —
            // don't let a second person collide with them.
            socket.emit("name-taken", { name: safeName });
            return;
        }

        chatUserId = userKey;

        socket.join(userKey);

        onlineChatUsers.set(
            chatUserId,
            { name: safeName, socketId: socket.id, avatar: null }
        );

        socket.data.name = safeName;

        if (safeEmail) {
            rememberUserEmail(safeName, safeEmail);
        }

        // rejoin the room for every group this user already
        // belongs to, so group messages/calls reach them without
        // needing to re-open each group chat first
        const myGroups = [];

        groupsStore.forEach(group => {

            if (group.memberIds.includes(chatUserId)) {
                socket.join(group.id);
                myGroups.push(group);
            }
        });

        socket.emit("joined", { id: chatUserId, name: safeName });
        socket.emit("my-groups", myGroups);
        broadcastChatUserList();
        socket.broadcast.emit(
            "system-message",
            `${safeName} joined the chat`
        );
    });

    socket.on("forgot-name", ({ email } = {}) => {

        const name = lookupNameByEmail(email);

        socket.emit("name-lookup-result", {
            found: !!name,
            name: name || null,
            email
        });
    });

    socket.on("set-avatar", (avatarUrl) => {

        if (!chatUserId || !onlineChatUsers.has(chatUserId)) return;

        const user = onlineChatUsers.get(chatUserId);

        user.avatar = isSafeAvatarUrl(avatarUrl) ? avatarUrl : null;

        broadcastChatUserList();
    });

    socket.on("chat-message", (payload) => {

        if (!payload || !payload.toId || !chatUserId) return;

        // for a group, only members may post into it, and if the
        // group is admin-only ("announcement" mode) non-admins are
        // blocked from sending too
        if (isGroupId(payload.toId)) {
            const group = groupsStore.get(payload.toId);
            if (!group || !group.memberIds.includes(chatUserId)) return;

            if (group.adminsOnlyMessages && !group.adminIds.includes(chatUserId)) {
                socket.emit("group-error", { message: "Only admins can send messages in this group." });
                return;
            }
        } else if (isBlockedPair(readBlockedStore(), chatUserId, payload.toId)) {

            // one of the two has blocked the other - refuse the send
            // outright rather than silently swallowing it, so the
            // sender's UI doesn't show a message that never arrives
            socket.emit("group-error", { message: "You can't message this contact." });
            return;
        }

        const senderAvatar =
            chatUserId && onlineChatUsers.has(chatUserId)
                ? onlineChatUsers.get(chatUserId).avatar
                : null;

        const from = { id: chatUserId, name: socket.data.name, avatar: senderAvatar };

        // ids of members @mentioned in this message (group chats only) -
        // the client resolves @name into an id as it's typed, so this
        // is trusted to just be a list of ids, not re-parsed from text
        const mentions =
            Array.isArray(payload.mentions)
                ? payload.mentions.filter(id => typeof id === "string" && id.trim()).slice(0, 50)
                : [];

        const message = {
            id: nanoid(10),
            from,
            toId: payload.toId,
            text: payload.text || null,
            attachment: payload.attachment || null,
            replyTo: payload.replyTo || null,
            forwarded: !!payload.forwarded,
            mentions,
            at: Date.now()
        };

        // persist to disk so it's there next time either side opens
        // this conversation (after a refresh, reconnect, etc.), and
        // stamp an expiry on it if disappearing messages are on for
        // this conversation
        saveChatMessage(chatUserId, payload.toId, message);

        // `socket.to` (not `io.to`) excludes our own socket, which
        // matters for a group: everyone posting into one is a
        // member of its room, so a plain `io.to` would otherwise
        // deliver the message to the sender twice once combined
        // with the explicit echo right below. For a 1:1 chat this
        // behaves exactly the same as `io.to` did, since the sender
        // was never in the recipient's personal room anyway.
        socket.to(payload.toId).emit("chat-message", message);
        socket.emit("chat-message", message); // echo back to sender
    });

    // a client opening a conversation asks for what's already been
    // saved, plus where it (and the other person) last left off and
    // whether disappearing messages are on
    socket.on("get-history", ({ toId } = {}) => {

        if (!toId || !chatUserId) return;
        if (isGroupId(toId)) return; // groups use get-group-history instead

        const store = readChatHistoryStore();
        const key = conversationKey(chatUserId, toId);
        const convo = getOrCreateConversation(store, key);

        socket.emit("chat-history", {
            toId,
            messages: convo.messages,
            disappearing: convo.disappearing,
            pinnedMessageId: convo.pinnedMessageId || null,
            lastRead: {
                mine: convo.lastRead[chatUserId] || null,
                theirs: convo.lastRead[toId] || null
            }
        });
    });

    // same idea as get-history, but for a group: one shared
    // conversation (keyed by the group's own id) instead of a
    // per-sender-pair one, and no per-person lastRead tracking
    socket.on("get-group-history", ({ groupId } = {}) => {

        if (!groupId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group || !group.memberIds.includes(chatUserId)) return;

        const store = readChatHistoryStore();
        const convo = getOrCreateConversation(store, groupId);

        socket.emit("group-history", {
            groupId,
            messages: convo.messages,
            disappearing: convo.disappearing,
            pinnedMessageId: convo.pinnedMessageId || null
        });
    });

    // remembers the last message this user has seen in a conversation,
    // so re-opening it (even on another device, later) can pick up
    // right where they reached instead of always jumping to the very
    // bottom
    socket.on("mark-read", ({ toId, messageId } = {}) => {

        if (!toId || !messageId || !chatUserId) return;
        if (isGroupId(toId)) return; // per-person read receipts aren't tracked for groups

        const store = readChatHistoryStore();
        const key = conversationKey(chatUserId, toId);
        const convo = getOrCreateConversation(store, key);

        convo.lastRead[chatUserId] = messageId;
        writeChatHistoryStore(store);

        socket.to(toId).emit("read-receipt", { fromId: chatUserId, messageId });
    });

    // toggles disappearing messages for a conversation; either
    // participant can change it, and it applies to both sides
    socket.on("set-disappearing", ({ toId, seconds } = {}) => {

        if (!toId || !chatUserId) return;

        const normalizedSeconds =
            ALLOWED_DISAPPEARING_SECONDS.includes(Number(seconds))
                ? Number(seconds)
                : 0;

        const store = readChatHistoryStore();
        const key = isGroupId(toId) ? toId : conversationKey(chatUserId, toId);
        const convo = getOrCreateConversation(store, key);

        convo.disappearing = {
            enabled: normalizedSeconds > 0,
            seconds: normalizedSeconds
        };

        writeChatHistoryStore(store);

        const update = {
            toId: chatUserId, // from the other person's point of view
            fromId: chatUserId,
            fromName: socket.data.name,
            enabled: convo.disappearing.enabled,
            seconds: normalizedSeconds
        };

        socket.to(toId).emit("disappearing-updated", update);
        socket.emit("disappearing-updated", { ...update, toId });
    });

    socket.on("typing", (toId) => {
        if (toId) socket.to(toId).emit("typing", { fromId: chatUserId, toId });
    });

    socket.on("react-message", ({ toId, messageId, emoji, remove } = {}) => {

        if (!toId || !messageId || !emoji || !chatUserId) return;

        // persist onto the stored message so the reaction survives a
        // refresh/reconnect instead of only living in memory
        const store = readChatHistoryStore();
        const key = isGroupId(toId) ? toId : conversationKey(chatUserId, toId);
        const convo = getOrCreateConversation(store, key);
        const stored = convo.messages.find(m => m.id === messageId);

        if (stored) {

            if (!stored.reactions) stored.reactions = {};
            if (!stored.reactions[emoji]) stored.reactions[emoji] = [];

            const idx = stored.reactions[emoji].indexOf(chatUserId);

            if (remove) {
                if (idx !== -1) stored.reactions[emoji].splice(idx, 1);
                if (!stored.reactions[emoji].length) delete stored.reactions[emoji];
            } else if (idx === -1) {
                stored.reactions[emoji].push(chatUserId);
            }

            writeChatHistoryStore(store);
        }

        const payload = {
            messageId,
            emoji,
            remove: !!remove,
            fromId: chatUserId,
            toId
        };

        // relay to the other participant(s), and echo back to the
        // sender so both sides stay in sync
        socket.to(toId).emit("message-reaction", payload);
        socket.emit("message-reaction", payload);
    });

    socket.on("pin-message", ({ toId, messageId } = {}) => {

        if (!toId || !chatUserId) return;

        // persist the pin on the conversation itself so it's still
        // pinned after a refresh/reconnect, not just for this session
        const store = readChatHistoryStore();
        const key = isGroupId(toId) ? toId : conversationKey(chatUserId, toId);
        const convo = getOrCreateConversation(store, key);

        convo.pinnedMessageId = messageId || null;
        writeChatHistoryStore(store);

        const payload = {
            messageId: messageId || null,
            fromId: chatUserId,
            toId
        };

        socket.to(toId).emit("message-pinned", payload);
        socket.emit("message-pinned", payload);
    });

    // ------------------------------------------------------
    // FRIEND REQUESTS
    // (the client already has full UI for this — it was just
    // missing these server-side relays)
    // ------------------------------------------------------

    socket.on("friend-request", ({ toId } = {}) => {

        if (!toId || !chatUserId) return;

        io.to(toId).emit("friend-request", {
            fromId: chatUserId,
            fromName: socket.data.name
        });
    });

    socket.on("friend-request-response", ({ fromId, accept } = {}) => {

        if (!fromId || !chatUserId) return;

        if (accept) {
            io.to(fromId).emit("friend-request-accepted", {
                userId: chatUserId,
                name: socket.data.name,
                avatar:
                    onlineChatUsers.has(chatUserId)
                        ? onlineChatUsers.get(chatUserId).avatar
                        : null
            });
        } else {
            io.to(fromId).emit("friend-request-declined", { userId: chatUserId });
        }
    });

    socket.on("friend-remove", ({ toId } = {}) => {

        if (!toId || !chatUserId) return;

        // let the other person's client drop them from its friend
        // list too, so removing a friend is a two-way action
        io.to(toId).emit("friend-removed", { userId: chatUserId });
    });

    socket.on("delete-message", ({ toId, messageId }) => {

        if (!toId || !messageId || !chatUserId) return;

        removeStoredMessage(chatUserId, toId, messageId);

        const payload = {
            messageId,
            fromId: chatUserId,
            toId
        };

        // tell the other participant(s) it's gone, and echo back to
        // the sender so both sides swap the bubble for a "deleted" placeholder
        socket.to(toId).emit("message-deleted", payload);
        socket.emit("message-deleted", payload);
    });

    socket.on("call-user", ({ toId, offer, callType }) => {
        io.to(toId).emit("incoming-call", {
            fromId: chatUserId,
            fromName: socket.data.name,
            offer,
            callType // "audio" | "video"
        });
    });

    socket.on("call-answer", ({ toId, answer }) => {
        io.to(toId).emit("call-answer", { fromId: chatUserId, answer });
    });

    socket.on("ice-candidate", ({ toId, candidate }) => {
        io.to(toId).emit("ice-candidate", { fromId: chatUserId, candidate });
    });

    socket.on("call-reject", ({ toId }) => {
        io.to(toId).emit("call-rejected", { fromId: chatUserId });
    });

    socket.on("call-end", ({ toId }) => {
        io.to(toId).emit("call-ended", { fromId: chatUserId });
    });


    // ------------------------------------------------------
    // GROUP CHAT MANAGEMENT
    // ------------------------------------------------------

    socket.on("create-group", ({ name, memberIds } = {}) => {

        if (!chatUserId) return;

        const safeName =
            String(name || "New Group").slice(0, 60).trim() || "New Group";

        const chosenIds =
            Array.isArray(memberIds)
                ? memberIds.filter(id => typeof id === "string" && id.trim())
                : [];

        const memberSet = new Set([chatUserId, ...chosenIds]);

        if (memberSet.size < 2) {
            socket.emit("group-error", { message: "Pick at least one other member." });
            return;
        }

        const group = {
            id: "g_" + nanoid(14),
            name: safeName,
            icon: null,
            description: "",
            adminsOnlyMessages: false,
            inviteCode: nanoid(10),
            memberIds: Array.from(memberSet),
            adminIds: [chatUserId],
            createdBy: chatUserId,
            createdByName: socket.data.name,
            createdAt: Date.now()
        };

        groupsStore.set(group.id, group);
        persistGroups();

        joinGroupRoomForMembers(group);

        io.to(group.id).emit("group-created", group);
    });

    socket.on("add-group-members", ({ groupId, memberIds } = {}) => {

        if (!groupId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group) return;

        if (!group.adminIds.includes(chatUserId)) {
            socket.emit("group-error", { message: "Only admins can add members." });
            return;
        }

        const newIds =
            (Array.isArray(memberIds) ? memberIds : [])
                .filter(id => typeof id === "string" && id.trim() && !group.memberIds.includes(id));

        if (!newIds.length) return;

        group.memberIds.push(...newIds);
        persistGroups();

        joinGroupRoomForMembers(group);

        io.to(group.id).emit("group-updated", group);
    });

    socket.on("remove-group-member", ({ groupId, memberId } = {}) => {

        if (!groupId || !memberId || !chatUserId) return;

        removeGroupMember(groupId, memberId, chatUserId, socket);
    });

    socket.on("leave-group", ({ groupId } = {}) => {

        if (!groupId || !chatUserId) return;

        removeGroupMember(groupId, chatUserId, chatUserId, socket);
    });

    socket.on("rename-group", ({ groupId, name } = {}) => {

        if (!groupId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group || !group.adminIds.includes(chatUserId)) return;

        const safeName = String(name || "").slice(0, 60).trim();
        if (!safeName) return;

        group.name = safeName;
        persistGroups();

        io.to(group.id).emit("group-updated", group);
    });

    socket.on("get-my-groups", () => {

        if (!chatUserId) return;

        const mine =
            Array.from(groupsStore.values())
                .filter(g => g.memberIds.includes(chatUserId));

        socket.emit("my-groups", mine);
    });

    socket.on("set-group-description", ({ groupId, description } = {}) => {

        if (!groupId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group || !group.adminIds.includes(chatUserId)) {
            socket.emit("group-error", { message: "Only admins can edit the group description." });
            return;
        }

        group.description = String(description || "").slice(0, 500).trim();
        persistGroups();

        io.to(group.id).emit("group-updated", group);
    });

    socket.on("set-group-icon", ({ groupId, iconUrl } = {}) => {

        if (!groupId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group || !group.adminIds.includes(chatUserId)) {
            socket.emit("group-error", { message: "Only admins can change the group icon." });
            return;
        }

        group.icon = isSafeAvatarUrl(iconUrl) ? iconUrl : null;
        persistGroups();

        io.to(group.id).emit("group-updated", group);
    });

    // WhatsApp-style "make group admin" / "remove as admin"
    socket.on("promote-group-admin", ({ groupId, memberId } = {}) => {

        if (!groupId || !memberId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group || !group.adminIds.includes(chatUserId)) {
            socket.emit("group-error", { message: "Only admins can promote members." });
            return;
        }

        if (!group.memberIds.includes(memberId)) return;
        if (!group.adminIds.includes(memberId)) group.adminIds.push(memberId);

        persistGroups();
        io.to(group.id).emit("group-updated", group);
    });

    socket.on("demote-group-admin", ({ groupId, memberId } = {}) => {

        if (!groupId || !memberId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group || !group.adminIds.includes(chatUserId)) {
            socket.emit("group-error", { message: "Only admins can remove another admin." });
            return;
        }

        // never allow the last admin to be demoted - a group with
        // members but no admin at all could no longer be managed
        if (group.adminIds.length <= 1) {
            socket.emit("group-error", { message: "A group needs at least one admin." });
            return;
        }

        group.adminIds = group.adminIds.filter(id => id !== memberId);
        persistGroups();

        io.to(group.id).emit("group-updated", group);
    });

    // WhatsApp's "Send Messages" group permission - when on, only
    // admins can post and everyone else sees a read-only chat
    socket.on("set-group-send-permission", ({ groupId, adminsOnly } = {}) => {

        if (!groupId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group || !group.adminIds.includes(chatUserId)) {
            socket.emit("group-error", { message: "Only admins can change this setting." });
            return;
        }

        group.adminsOnlyMessages = !!adminsOnly;
        persistGroups();

        io.to(group.id).emit("group-updated", group);
    });

    // any member can fetch the current invite link (created lazily
    // for groups that existed before this feature)
    socket.on("get-group-invite", ({ groupId } = {}) => {

        if (!groupId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group || !group.memberIds.includes(chatUserId)) return;

        if (!group.inviteCode) {
            group.inviteCode = nanoid(10);
            persistGroups();
        }

        socket.emit("group-invite", { groupId: group.id, code: group.inviteCode });
    });

    // admins can invalidate the old link and hand out a fresh one
    socket.on("revoke-group-invite", ({ groupId } = {}) => {

        if (!groupId || !chatUserId) return;

        const group = groupsStore.get(groupId);
        if (!group || !group.adminIds.includes(chatUserId)) {
            socket.emit("group-error", { message: "Only admins can reset the invite link." });
            return;
        }

        group.inviteCode = nanoid(10);
        persistGroups();

        socket.emit("group-invite", { groupId: group.id, code: group.inviteCode });
    });

    // joining a group via a shared invite link/code
    socket.on("join-group-via-invite", ({ code } = {}) => {

        if (!code || !chatUserId) return;

        const group =
            Array.from(groupsStore.values())
                .find(g => g.inviteCode === code);

        if (!group) {
            socket.emit("group-error", { message: "That invite link is invalid or has expired." });
            return;
        }

        if (!group.memberIds.includes(chatUserId)) {
            group.memberIds.push(chatUserId);
            persistGroups();
        }

        joinGroupRoomForMembers(group);

        io.to(group.id).emit("group-updated", group);
    });


    // ------------------------------------------------------
    // MULTI-PARTY (GROUP) CALLING
    //
    // Same philosophy as the 1:1 call events above: the server
    // never tracks who's "in" a call - it only relays signaling
    // messages by id, and the clients build the actual mesh of
    // direct peer connections between each other. This is also
    // what "add a person to an ongoing call" runs on: adding
    // someone is just ringing one more id and handing them the
    // current participant list so they know who to connect to,
    // whether the call started as a 1:1 call or a group call.
    // ------------------------------------------------------

    // Ring `toId` to join `callId`. `participantIds`/`participantNames`
    // is a snapshot of who's already on the call, provided by the
    // inviter, so the invitee knows who to connect to once they accept.
    socket.on("call-add-participant", ({ toId, callId, callType, participantIds, participantNames } = {}) => {

        if (!toId || !callId || !chatUserId) return;

        io.to(toId).emit("call-add-invite", {
            fromId: chatUserId,
            fromName: socket.data.name,
            callId,
            callType,
            participantIds: Array.isArray(participantIds) ? participantIds : [],
            participantNames: Array.isArray(participantNames) ? participantNames : []
        });
    });

    socket.on("call-add-decline", ({ toId, callId } = {}) => {

        if (!toId || !callId || !chatUserId) return;

        io.to(toId).emit("call-add-declined", { fromId: chatUserId, callId });
    });

    // Direct pairwise offer/answer/ICE between two participants
    // already (or about to be) in the same multi-party call.
    socket.on("group-peer-offer", ({ toId, callId, offer } = {}) => {

        if (!toId || !callId || !chatUserId) return;

        io.to(toId).emit("group-peer-offer", {
            fromId: chatUserId,
            fromName: socket.data.name,
            callId,
            offer
        });
    });

    socket.on("group-peer-answer", ({ toId, callId, answer } = {}) => {

        if (!toId || !callId || !chatUserId) return;

        io.to(toId).emit("group-peer-answer", { fromId: chatUserId, callId, answer });
    });

    socket.on("group-peer-ice", ({ toId, callId, candidate } = {}) => {

        if (!toId || !callId || !chatUserId) return;

        io.to(toId).emit("group-peer-ice", { fromId: chatUserId, callId, candidate });
    });

    // One participant leaving a multi-party call - only that one
    // peer connection needs to be torn down on the other end, not
    // a whole "room" (there isn't one; it's a pure mesh of relays).
    socket.on("group-peer-bye", ({ toId, callId } = {}) => {

        if (!toId || !callId || !chatUserId) return;

        io.to(toId).emit("group-peer-bye", { fromId: chatUserId, callId });
    });


    // ------------------------------------------------------
    // BLOCK USER / CLEAR CHAT
    // ------------------------------------------------------

    socket.on("block-user", ({ userId } = {}) => {

        if (!userId || !chatUserId) return;

        const store = readBlockedStore();
        if (!Array.isArray(store[chatUserId])) store[chatUserId] = [];

        if (!store[chatUserId].includes(userId)) {
            store[chatUserId].push(userId);
            writeBlockedStore(store);
        }
    });

    socket.on("clear-chat", ({ chatId, deleteStarred } = {}) => {

        if (!chatId || !chatUserId) return;

        const store = readChatHistoryStore();
        const key = isGroupId(chatId) ? chatId : conversationKey(chatUserId, chatId);
        const convo = getOrCreateConversation(store, key);

        convo.messages = deleteStarred
            ? []
            : convo.messages.filter(m => m.starred);

        writeChatHistoryStore(store);
    });


    // ------------------------------------------------------
    // STATUS / STORIES
    // ------------------------------------------------------

    socket.on("get-statuses", () => {

        if (!chatUserId) return;

        const store = readStatusesStore();
        if (pruneExpiredStatuses(store)) writeStatusesStore(store);

        socket.emit("statuses", buildStatusGroups(store));
    });

    socket.on("post-status", (payload = {}) => {

        if (!chatUserId) return;

        const kind = payload.kind === "media" ? "media" : "text";

        const update = {
            id: nanoid(10),
            kind,
            text: kind === "text" ? String(payload.text || "").slice(0, 700) : null,
            color: kind === "text" ? String(payload.color || "green").slice(0, 20) : null,
            url: kind === "media" && isSafeAvatarUrl(payload.url) ? payload.url : null,
            caption: kind === "media" ? String(payload.caption || "").slice(0, 300) : null,
            privacy: typeof payload.privacy === "string" ? payload.privacy.slice(0, 30) : "contacts",
            time: Date.now(),
            viewers: [],
            likes: []
        };

        if (kind === "text" && !update.text) return;
        if (kind === "media" && !update.url) return;

        const store = readStatusesStore();
        pruneExpiredStatuses(store);

        const ownerAvatar =
            (onlineChatUsers.has(chatUserId) && onlineChatUsers.get(chatUserId).avatar) || null;

        if (!store[chatUserId]) store[chatUserId] = { name: socket.data.name, avatar: ownerAvatar, updates: [] };
        store[chatUserId].name = socket.data.name;
        store[chatUserId].avatar = ownerAvatar;
        store[chatUserId].updates.push(update);

        writeStatusesStore(store);

        // just a "something changed, go re-fetch" ping - the client
        // re-requests the full list on receipt (see requestStatuses())
        io.emit("status-posted", { ownerId: chatUserId });
    });

    socket.on("view-status", ({ statusId, ownerId } = {}) => {

        if (!statusId || !ownerId || !chatUserId) return;

        const store = readStatusesStore();
        const owner = store[ownerId];
        const update = owner && owner.updates.find(u => u.id === statusId);

        if (!update) return;

        if (!Array.isArray(update.viewers)) update.viewers = [];

        if (!update.viewers.some(v => v.id === chatUserId)) {
            update.viewers.push({ id: chatUserId, name: socket.data.name, at: Date.now() });
            writeStatusesStore(store);
        }

        // lets the owner's own open viewer live-update its view count
        io.to(ownerId).emit("status-posted", { ownerId });
    });

    socket.on("like-status", ({ statusId, ownerId } = {}) => {

        if (!statusId || !ownerId || !chatUserId) return;

        const store = readStatusesStore();
        const owner = store[ownerId];
        const update = owner && owner.updates.find(u => u.id === statusId);

        if (!update) return;

        if (!Array.isArray(update.likes)) update.likes = [];

        const alreadyLiked = update.likes.some(l => l.id === chatUserId);

        if (alreadyLiked) {
            update.likes = update.likes.filter(l => l.id !== chatUserId);
        } else {
            update.likes.push({ id: chatUserId, name: socket.data.name, at: Date.now() });
        }

        writeStatusesStore(store);

        // lets the owner's own open viewer (and the liker) live-update
        io.to(ownerId).emit("status-posted", { ownerId });
        socket.emit("status-posted", { ownerId });
    });

    socket.on("delete-status", ({ statusId } = {}) => {

        if (!statusId || !chatUserId) return;

        const store = readStatusesStore();
        const owner = store[chatUserId];
        if (!owner) return;

        owner.updates = owner.updates.filter(u => u.id !== statusId);
        if (!owner.updates.length) delete store[chatUserId];

        writeStatusesStore(store);

        io.emit("status-posted", { ownerId: chatUserId });
    });


    // ------------------------------------------------------
    // CHANNELS
    // (one-way broadcast rooms - reuses the exact same
    // memberIds/adminIds shape groups already use, so
    // chat-message/typing/etc. keep working unchanged once a
    // channel id is passed in as `toId`)
    // ------------------------------------------------------

    socket.on("get-channels", () => {

        if (!chatUserId) return;

        socket.emit("channels-list", Object.values(readChannelsStore()));
    });

    socket.on("create-channel", ({ name, description, icon } = {}) => {

        if (!chatUserId) return;

        const safeName = String(name || "New Channel").slice(0, 60).trim() || "New Channel";

        const channel = {
            id: "ch_" + nanoid(14),
            name: safeName,
            description: String(description || "").slice(0, 300),
            icon: isSafeAvatarUrl(icon) ? icon : null,
            createdBy: chatUserId,
            createdByName: socket.data.name,
            createdAt: Date.now(),
            memberIds: [chatUserId],
            adminIds: [chatUserId]
        };

        const store = readChannelsStore();
        store[channel.id] = channel;
        writeChannelsStore(store);

        socket.join(channel.id);

        io.emit("channels-list", Object.values(store));
    });


    // ------------------------------------------------------
    // COMMUNITIES
    // (a named collection of existing groups)
    // ------------------------------------------------------

    socket.on("get-communities", () => {

        if (!chatUserId) return;

        socket.emit("communities-list", Object.values(readCommunitiesStore()));
    });

    socket.on("create-community", ({ name, description, icon, groupIds } = {}) => {

        if (!chatUserId) return;

        const safeName = String(name || "New Community").slice(0, 60).trim() || "New Community";

        const community = {
            id: "cm_" + nanoid(14),
            name: safeName,
            description: String(description || "").slice(0, 300),
            icon: isSafeAvatarUrl(icon) ? icon : null,
            groupIds: Array.isArray(groupIds) ? groupIds.filter(id => groupsStore.has(id)) : [],
            createdBy: chatUserId,
            createdByName: socket.data.name,
            createdAt: Date.now()
        };

        const store = readCommunitiesStore();
        store[community.id] = community;
        writeCommunitiesStore(store);

        io.emit("communities-list", Object.values(store));
    });


    // ------------------------------------------------------
    // MESSAGE CONTEXT MENU (right-click / long-press)
    // Only "star" needs a server round-trip: reply/copy are
    // handled entirely client-side, and pin/delete already have
    // their own dedicated events higher up in this file.
    // ------------------------------------------------------

    socket.on("message-context-action", ({ action, msgId, chatId } = {}) => {

        if (action !== "star" || !msgId || !chatId || !chatUserId) return;

        const store = readChatHistoryStore();
        const key = isGroupId(chatId) ? chatId : conversationKey(chatUserId, chatId);
        const convo = getOrCreateConversation(store, key);
        const stored = convo.messages.find(m => m.id === msgId);

        if (!stored) return;

        stored.starred = !stored.starred;
        writeChatHistoryStore(store);
    });


    socket.on("disconnect", () => {

        if (chatUserId && onlineChatUsers.has(chatUserId)) {

            const name = onlineChatUsers.get(chatUserId).name;
            onlineChatUsers.delete(chatUserId);
            broadcastChatUserList();
            socket.broadcast.emit(
                "system-message",
                `${name} left the chat`
            );
        }
    });
});


// ---------------------------------------------------------
// GROUPS (group chat + group calls)
// Groups are persisted the same lightweight way as the users
// registry/chat history above (best-effort disk store in the
// OS temp dir). A group is also a Socket.io "room": every
// member's socket joins a room named after the group's id, so
// all of the existing 1:1 relays below (chat-message, typing,
// react-message, pin-message, delete-message, disappearing)
// work for groups with NO changes to their own logic - they
// already just do `io.to(toId)`/`socket.to(toId)`, and toId is
// simply a group id instead of a person's id.
//
// Group ids always start with "g_" so a plain membership check
// (isGroupId) never needs a lookup, and can never collide with
// a user id (which is just a lowercased display name).
// ---------------------------------------------------------

const groupsFile =
    path.join(os.tmpdir(), "site-chat-groups.json");

const groupsStore = new Map();

function isGroupId(id) {
    return typeof id === "string" && id.startsWith("g_");
}

// fills in fields that didn't exist yet when this group was first
// created (older groups on disk, or groups from before a feature
// like description/invite links/admin-only mode was added)
function normalizeGroup(group) {

    if (typeof group.icon === "undefined") group.icon = null;
    if (typeof group.description !== "string") group.description = "";
    if (typeof group.adminsOnlyMessages !== "boolean") group.adminsOnlyMessages = false;
    if (typeof group.inviteCode !== "string" || !group.inviteCode) group.inviteCode = nanoid(10);

    return group;
}

function loadGroupsFromDisk() {

    try {

        if (!fs.existsSync(groupsFile)) return;

        const raw = fs.readFileSync(groupsFile, "utf8");
        if (!raw.trim()) return;

        const data = JSON.parse(raw);
        if (!data || typeof data !== "object") return;

        Object.values(data).forEach(group => {
            if (group && group.id) groupsStore.set(group.id, normalizeGroup(group));
        });

    } catch (error) {

        console.error("Unable to read groups store:", error.message);
    }
}

function persistGroups() {

    try {

        const plain = {};
        groupsStore.forEach((group, id) => { plain[id] = group; });

        fs.writeFileSync(
            groupsFile,
            JSON.stringify(plain, null, 2),
            "utf8"
        );

    } catch (error) {

        console.error("Unable to write groups store:", error.message);
    }
}

loadGroupsFromDisk();

// Joins every currently-online member of a group to its room -
// safe to call repeatedly (Socket.io no-ops joining a room you're
// already in).
function joinGroupRoomForMembers(group) {

    group.memberIds.forEach(memberId => {

        const info = onlineChatUsers.get(memberId);
        if (!info) return;

        const memberSocket = io.sockets.sockets.get(info.socketId);
        if (memberSocket) memberSocket.join(group.id);
    });
}

// Shared by both "leave-group" (self) and "remove-group-member"
// (admin acting on someone else).
function removeGroupMember(groupId, memberId, requestedBy, requestedBySocket) {

    const group = groupsStore.get(groupId);
    if (!group) return;

    const isSelf = memberId === requestedBy;

    if (!isSelf && !group.adminIds.includes(requestedBy)) {
        if (requestedBySocket) {
            requestedBySocket.emit("group-error", { message: "Only admins can remove members." });
        }
        return;
    }

    if (!group.memberIds.includes(memberId)) return;

    group.memberIds = group.memberIds.filter(id => id !== memberId);
    group.adminIds = group.adminIds.filter(id => id !== memberId);

    // keep the group from ending up with members but no admin
    if (group.adminIds.length === 0 && group.memberIds.length > 0) {
        group.adminIds.push(group.memberIds[0]);
    }

    const info = onlineChatUsers.get(memberId);
    if (info) {
        const memberSocket = io.sockets.sockets.get(info.socketId);
        if (memberSocket) memberSocket.leave(groupId);
    }

    if (group.memberIds.length === 0) {
        groupsStore.delete(groupId);
    }

    persistGroups();

    io.to(memberId).emit(isSelf ? "left-group" : "removed-from-group", { groupId });

    if (group.memberIds.length > 0) {
        io.to(groupId).emit("group-updated", group);
    }
}


// ---------------------------------------------------------
// DISAPPEARING MESSAGES CLEANUP
// runs periodically so messages vanish for everyone even if
// neither participant has the chat open right now
// ---------------------------------------------------------

function pruneDisappearingMessagesNow() {

    const store = readChatHistoryStore();
    const removedByKey = pruneExpiredMessages(store);

    if (!Object.keys(removedByKey).length) return;

    writeChatHistoryStore(store);

    for (const key of Object.keys(removedByKey)) {

        const [userA, userB] = key.split("::");

        for (const messageId of removedByKey[key]) {

            const payload = { messageId, fromId: "system", toId: userB };

            io.to(userA).emit("message-deleted", { ...payload, toId: userA });
            io.to(userB).emit("message-deleted", { ...payload, toId: userB });
        }
    }
}

setInterval(pruneDisappearingMessagesNow, 60 * 1000);


/*
=========================================================
SITE CHAT - EXTRA FEATURES
(status/stories, channels, communities, blocking, clear
chat, and the message right-click/long-press menu. These
were fully built on the client (nodi.html/client.js) but
had no server-side handlers at all, so every one of these
buttons silently did nothing. They're persisted the same
lightweight way as the users registry/chat history/groups
above: a best-effort JSON file in the OS temp dir - good
enough for a single server instance without a real DB.

NOTE ON PRIVACY: like friends (see FRIEND REQUESTS above),
this server doesn't keep a persistent contacts graph - that
lives only in each client's localStorage. So a status's
"My contacts" / "Only share with..." privacy option is
stored but not enforced server-side; every status is
visible to every signed-in user for now. Real per-viewer
privacy would need a server-side contacts list, which is a
bigger change than this pass covers.
=========================================================
*/

const statusesFile = path.join(os.tmpdir(), "site-chat-statuses.json");
const channelsFile = path.join(os.tmpdir(), "site-chat-channels.json");
const communitiesFile = path.join(os.tmpdir(), "site-chat-communities.json");
const blockedUsersFile = path.join(os.tmpdir(), "site-chat-blocked.json");

const STATUS_LIFETIME_MS = 24 * 60 * 60 * 1000; // stories disappear after 24h

function readJsonStore(file, fallback) {

    try {

        if (!fs.existsSync(file)) return fallback;

        const raw = fs.readFileSync(file, "utf8");
        if (!raw.trim()) return fallback;

        const data = JSON.parse(raw);
        return (data && typeof data === "object") ? data : fallback;

    } catch (error) {

        console.error(`Unable to read ${path.basename(file)}:`, error.message);
        return fallback;
    }
}

function writeJsonStore(file, data) {

    try {

        fs.writeFileSync(file, JSON.stringify(data), "utf8");

    } catch (error) {

        console.error(`Unable to write ${path.basename(file)}:`, error.message);
    }
}

// ---- statuses / stories ----

function readStatusesStore() { return readJsonStore(statusesFile, {}); }
function writeStatusesStore(store) { writeJsonStore(statusesFile, store); }

// drops updates older than STATUS_LIFETIME_MS; returns true if anything
// was actually removed, so callers only write back to disk when needed
function pruneExpiredStatuses(store) {

    const now = Date.now();
    let changed = false;

    for (const ownerId of Object.keys(store)) {

        const owner = store[ownerId];
        if (!owner || !Array.isArray(owner.updates)) continue;

        const kept = owner.updates.filter(u => (u.time + STATUS_LIFETIME_MS) > now);

        if (kept.length !== owner.updates.length) changed = true;

        if (kept.length) owner.updates = kept;
        else delete store[ownerId];
    }

    return changed;
}

// shapes the store into the array-of-groups the client's status list
// (and viewer) expects, most recently updated owner first
function buildStatusGroups(store) {

    return Object.keys(store)
        .map(ownerId => ({
            id: ownerId,
            name: store[ownerId].name,
            avatar: store[ownerId].avatar || null,
            updates: store[ownerId].updates
        }))
        .filter(group => group.updates.length)
        .sort((a, b) => {

            const aLatest = a.updates[a.updates.length - 1].time;
            const bLatest = b.updates[b.updates.length - 1].time;

            return bLatest - aLatest;
        });
}

// ---- channels ----

function readChannelsStore() { return readJsonStore(channelsFile, {}); }
function writeChannelsStore(store) { writeJsonStore(channelsFile, store); }

// ---- communities ----

function readCommunitiesStore() { return readJsonStore(communitiesFile, {}); }
function writeCommunitiesStore(store) { writeJsonStore(communitiesFile, store); }

// ---- blocking ----

function readBlockedStore() { return readJsonStore(blockedUsersFile, {}); }
function writeBlockedStore(store) { writeJsonStore(blockedUsersFile, store); }

// true once EITHER side has blocked the other - blocking is treated as
// mutual (like WhatsApp: once blocked, neither side's messages reach
// the other) rather than a one-way mute
function isBlockedPair(store, a, b) {

    const listA = Array.isArray(store[a]) ? store[a] : [];
    const listB = Array.isArray(store[b]) ? store[b] : [];

    return listA.includes(b) || listB.includes(a);
}


/*
=========================================================
READ ARTICLES
=========================================================
*/

function readArticles() {

    try {

        if (
            !fs.existsSync(
                articlesFile
            )
        ) {

            return [];
        }

        const raw =
            fs.readFileSync(
                articlesFile,
                "utf8"
            );

        if (!raw.trim()) {

            return [];
        }

        const data =
            JSON.parse(raw);

        return Array.isArray(data)
            ? data
            : [];

    } catch (error) {

        console.error(
            "Article database error:",
            error.message
        );

        return [];
    }
}


/*
=========================================================
SORT ARTICLES
=========================================================
*/

function sortArticles(articles) {

    return [...articles].sort(
        (a, b) => {

            const dateA =
                new Date(
                    a.date ||
                    a.updated ||
                    0
                ).getTime();

            const dateB =
                new Date(
                    b.date ||
                    b.updated ||
                    0
                ).getTime();

            return dateB - dateA;
        }
    );
}


/*
=========================================================
LIVE CONTEXT FOR CAMPUS AI
=========================================================
*/

function buildLiveContext(
    userMessage
) {

    const articles =
        sortArticles(
            readArticles()
        );

    if (!articles.length) {

        return "";
    }

    const query =
        String(
            userMessage || ""
        )
            .toLowerCase();

    const categories = [
        "University Alerts",
        "HELB",
        "KUCCPS",
        "Scholarships",
        "Jobs"
    ];

    const perCategoryLimit = 6;

    let sections = "";

    for (
        const category of categories
    ) {

        const items =
            articles
                .filter(
                    article =>
                        article.category ===
                        category
                )
                .slice(
                    0,
                    perCategoryLimit
                );

        if (!items.length) {
            continue;
        }

        sections +=
            `\n--- ${category} (most recent) ---\n`;

        for (
            const item of items
        ) {

            sections +=
                `\n* ${item.title}\n` +
                `  Date: ${item.date || "unknown"}\n` +
                `  Summary: ${String(item.summary || "").substring(0, 400)}\n` +
                `  Source: ${item.sourceUrl || item.source || "n/a"}\n`;
        }
    }

    // If the user's question mentions a specific keyword, also surface
    // any matching articles regardless of category/recency window.
    if (query) {

        const matches =
            articles
                .filter(
                    article =>
                        String(
                            article.title || ""
                        )
                            .toLowerCase()
                            .includes(query) ||
                        String(
                            article.summary || ""
                        )
                            .toLowerCase()
                            .includes(query)
                )
                .slice(0, 5);

        if (matches.length) {

            sections +=
                "\n--- Directly matching articles ---\n";

            for (
                const item of matches
            ) {

                sections +=
                    `\n* ${item.title}\n` +
                    `  Date: ${item.date || "unknown"}\n` +
                    `  Summary: ${String(item.summary || "").substring(0, 400)}\n` +
                    `  Source: ${item.sourceUrl || item.source || "n/a"}\n`;
            }
        }
    }

    if (!sections) {
        return "";
    }

    return (
        "\n\n===== LIVE SITE DATA (Kenya Campus Hub) =====" +
        sections +
        "\n===== END LIVE SITE DATA =====\n"
    );
}


/*
=========================================================
ALL CONTENT
=========================================================
*/

app.get(
    "/api/content",
    (req, res) => {

        try {

            const articles =
                sortArticles(
                    readArticles()
                );

            res.json(
                articles
            );

        } catch (error) {

            console.error(
                "Content error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load content."
            });
        }
    }
);


/*
=========================================================
CONTENT BY CATEGORY
=========================================================
*/

// Normalizes a category value for comparison so slugs like
// "university-alerts" (used in links/URLs) match stored category
// names like "University Alerts" (used in articles.json). Hyphens
// and underscores are treated the same as spaces, case is ignored,
// and repeated separators collapse to one.
function normalizeCategorySlug(value) {

    return String(value || "")
        .toLowerCase()
        .trim()
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ");
}

app.get(
    "/api/content/:category",
    (req, res) => {

        try {

            const category =
                normalizeCategorySlug(
                    req.params.category
                );

            const articles =
                readArticles();

            const results =
                articles.filter(
                    article =>
                        normalizeCategorySlug(
                            article.category
                        ) === category
                );

            res.json(
                sortArticles(results)
            );

        } catch (error) {

            console.error(
                "Category error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load category."
            });
        }
    }
);


/*
=========================================================
SINGLE ARTICLE
=========================================================
*/

app.get(
    "/api/article/:id",
    (req, res) => {

        try {

            const id =
                String(
                    req.params.id || ""
                );

            const articles =
                readArticles();

            const article =
                articles.find(
                    item =>
                        String(
                            item.id
                        ) === id
                );

            if (!article) {

                return res.status(404).json({
                    error:
                        "Article not found."
                });
            }

            res.json(
                article
            );

        } catch (error) {

            console.error(
                "Article error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load article."
            });
        }
    }
);


/*
=========================================================
SEARCH ARTICLES
=========================================================
*/

app.get(
    "/api/search",
    (req, res) => {

        try {

            const query =
                String(
                    req.query.q || ""
                )
                    .toLowerCase()
                    .trim();

            if (!query) {

                return res.json([]);
            }

            const articles =
                readArticles();

            const results =
                articles.filter(
                    article => {

                        const title =
                            String(
                                article.title || ""
                            )
                                .toLowerCase();

                        const summary =
                            String(
                                article.summary || ""
                            )
                                .toLowerCase();

                        const content =
                            String(
                                article.content || ""
                            )
                                .toLowerCase();

                        const category =
                            String(
                                article.category || ""
                            )
                                .toLowerCase();

                        return (
                            title.includes(query) ||
                            summary.includes(query) ||
                            content.includes(query) ||
                            category.includes(query)
                        );
                    }
                );

            res.json(
                sortArticles(results)
            );

        } catch (error) {

            console.error(
                "Search error:",
                error
            );

            res.status(500).json({
                error:
                    "Search failed."
            });
        }
    }
);


/*
=========================================================
CLEAN AI HISTORY
=========================================================
*/

function cleanAIHistory(history) {

    if (!Array.isArray(history)) {

        return [];
    }

    return history
        .filter(item => {

            if (!item) {

                return false;
            }

            const role =
                String(
                    item.role || ""
                ).toLowerCase();

            return (
                role === "user" ||
                role === "assistant"
            );
        })
        .map(item => {

            const role =
                String(
                    item.role
                ).toLowerCase();

            let content =
                String(
                    item.content || ""
                );

            if (
                content.length > 8000
            ) {

                content =
                    content.substring(
                        0,
                        8000
                    ) +
                    "\n[Earlier content shortened]";
            }

            return {
                role,
                content
            };
        })
        .slice(-16);
}


/*
=========================================================
AI SYSTEM PROMPT
=========================================================
*/

const AI_SYSTEM_PROMPT = `

You are the AI assistant inside Kenya Campus Hub.

Your behavior should feel natural, intelligent, helpful,
friendly and conversational, similar to a modern AI assistant.

Do not repeatedly introduce yourself.

Do not begin every answer with:
"Kenyan Campus AI"

Do not unnecessarily repeat the user's question.

Understand conversation context and follow-up questions.

If the user says:
- continue
- change that
- fix the code
- make it better
- use the code above
- add this feature
- the previous code
- that website
- that file

use the previous conversation to understand what they mean.

=========================================================
KENYAN STUDENTS
=========================================================

Help with:

- Kenyan universities
- University courses
- Campus life
- HELB
- KUCCPS
- Scholarships
- Student funding
- Accommodation
- Jobs
- Internships
- Side hustles
- Career advice
- M-PESA
- Student budgeting
- Personal finance basics
- University strikes, closures and unrest
- Academic calendar changes (reopening/closing dates, postponed exams)

You have access to a LIVE SITE DATA section below (when present) containing
the latest verified articles collected by Kenya Campus Hub across all
categories, including HELB, KUCCPS, Scholarships, Jobs, and University
Alerts (strikes/closures/unrest/calendar changes).

When a user asks about anything current — such as whether there is an
ongoing strike, a university closure, a scholarship deadline, or any other
time-sensitive matter — check the LIVE SITE DATA first and answer from it.

If the LIVE SITE DATA does not contain relevant current information, say so
clearly and advise the student to check the site's News/University Alerts
section or the relevant official source, rather than guessing or inventing
current details.

Do not invent current information.

Be careful with:
- deadlines
- fees
- government policies
- job vacancies
- scholarships
- examination dates
- university announcements
- current events

If current information cannot be verified,
say that it should be confirmed from the relevant official source.

=========================================================
ACADEMICS
=========================================================

Help with:

- Mathematics
- Management mathematics
- Accounting
- Finance
- Economics
- Statistics
- Management
- Marketing
- Insurance
- Business
- Computer science
- Programming

For mathematics:

1. Give the formula.
2. Substitute values.
3. Show calculations.
4. Explain important steps.
5. Give the final answer clearly.

For accounting specifically, in addition to the above:

- Journal entries: always show Debit and Credit as their own
  clearly labeled columns (e.g. a Markdown table with columns
  "Account", "Debit", "Credit"), never as a single inline
  line like "Dr Cash 5000, Cr Sales 5000".
- Ledger / T-accounts: lay out each account as its own block
  with Debit side and Credit side clearly separated, and
  balance it at the end.
- Trial balances, income statements, and balance sheets:
  use a Markdown table with items on the left and amounts
  right-aligned in their own column, and show subtotals
  before the final total rather than just one final number.
- Always show the workings that lead to a figure (e.g. how
  depreciation or closing stock was calculated) before using
  that figure in a statement, not just the final number with
  no derivation.
- State clearly which figures are given in the question and
  which were calculated.
- Give the full statement in ONE single Markdown table (not
  one table per section) so it reads as one continuous
  document, using a row with no amount, just a bolded label,
  as a section divider (e.g. a row for **Current Assets**),
  the same way the examples below are laid out.

Income statement layout to copy (adapt the line items and
figures to the actual question, keep this row structure):

| | KSh | KSh |
|---|---:|---:|
| **Sales** | | 500,000 |
| Less: Sales returns | | (10,000) |
| **Net sales** | | 490,000 |
| Less: Cost of goods sold | | |
| Opening stock | 40,000 | |
| Add: Purchases | 300,000 | |
| Less: Closing stock | (35,000) | (305,000) |
| **Gross profit** | | 185,000 |
| Less: Operating expenses | | |
| Rent | 20,000 | |
| Depreciation | 8,000 | (28,000) |
| **Net profit** | | 157,000 |

Balance sheet layout to copy (same idea: one table, bolded
subtotal/total rows, right-aligned amounts, assets balancing
against liabilities plus equity):

| | KSh | KSh |
|---|---:|---:|
| **Non-current assets** | | |
| Equipment (net of depreciation) | | 120,000 |
| **Current assets** | | |
| Stock | 35,000 | |
| Debtors | 15,000 | |
| Cash | 10,000 | 60,000 |
| **Total assets** | | 180,000 |
| **Equity** | | |
| Capital | | 130,000 |
| **Current liabilities** | | |
| Creditors | | 50,000 |
| **Total equity and liabilities** | | 180,000 |


=========================================================
PROGRAMMING
=========================================================

Support:

- HTML
- CSS
- JavaScript
- Node.js
- Express
- React
- Python
- Flask
- Django
- C#
- Unity
- Java
- C
- C++
- SQL
- PHP
- APIs
- REST APIs
- Databases
- JSON
- Git
- GitHub

When the user asks for code:

- Give complete working code when practical.
- Preserve existing functionality.
- Do not unnecessarily remove existing features.
- Use proper Markdown code fences.
- Always specify the programming language.
- Keep code readable.
- Use meaningful variable names.
- Explain important changes.

When modifying an existing project,
work with the structure the user provided.

=========================================================
CODE FORMAT
=========================================================

Always put programming code inside Markdown code fences,
with the language tag on the opening fence.

Example:

\`\`\`javascript
console.log("Hello");
\`\`\`

Do not put long programming code in ordinary paragraphs.

Structure code answers like this, in order:

1. A short sentence (1-3 lines) before the code saying what
   it does and, if relevant, why it's written that way -
   never silently drop straight into a code block with no
   lead-in.
2. One fenced code block with the language tag. Do not
   split one piece of code across multiple fences unless the
   user is working with multiple separate files - if so,
   give each file its own fence with the filename written
   just above it.
3. Comments inside the code only where they genuinely help
   (a non-obvious step, a gotcha) - not a comment on every
   line, and never a comment restating what the line already
   says.
4. After the code, a short explanation (a few lines or a
   small bullet list) of any non-obvious parts, trade-offs,
   or things the user needs to change (e.g. an API key,
   a file path) - skip this step entirely for short,
   self-explanatory snippets.

When fixing or changing existing code the user shared, show
only the part that changed when practical, clearly say what
was changed and why, rather than silently reprinting the
entire file back with no explanation.

=========================================================
DOCUMENTS
=========================================================

When the user uploads a document:

- Analyze the supplied document.
- Use the document content when answering.
- Summarize documents.
- Explain chapters.
- Answer questions from documents.
- Extract important notes.
- Analyze programming files.
- Correct code from uploaded files.
- Help solve examination questions.
- Do not claim to have read content that was not supplied.

=========================================================
STYLE
=========================================================

Be:

- Friendly
- Clear
- Patient
- Practical
- Intelligent
- Direct

Use simple English when appropriate.

Use emojis naturally.

Do not put emojis in every sentence.

For academic questions, teach the user.

For coding questions, prioritize working code.

For casual questions, respond naturally.

=========================================================
ANSWER DEPTH AND FORMATTING (IMPORTANT)
=========================================================

Give full, detailed answers written in complete sentences,
the way a patient human tutor would explain something -
not a compressed cheat-sheet.

Do NOT compress an explanation into a single line of
values or steps separated by slashes.

For example, do NOT write something like:
"Profit = Revenue - Cost = 5000 / 2000 = 3000"

Instead, write each step on its own line, in words, such as:
"Profit is Revenue minus Cost.
Revenue is 5000 and Cost is 2000.
So Profit = 5000 - 2000 = 3000."

Never use LaTeX or math markup such as \frac{}{}, \times,
\(...\), $...$ or $$...$$. This chat only renders plain
Markdown, so LaTeX shows up as broken raw code, not a formatted
equation. Write formulas in plain text instead: use / for a
fraction written out ("200/4"), * or x for multiplication, ^
for a power ("x^2"), and words for anything that would
otherwise need special notation ("the square root of 9").

The "/" character should only ever appear where it is
mathematically or grammatically correct (a fraction, a
date, a URL, "and/or") - never as a shorthand separator
standing in for "then", "gives", "equals", "or line break".

For calculations specifically, follow the 5-step academic
format already defined above (formula, substitute, show
calculation, explain, final answer), with each step as its
own clearly separated line or sentence, not chained together
with slashes.

Do not repeat the same sentence, phrase, or explanation more
than once within a single answer. If you have already made a
point, do not restate it in different words later in the same
response unless the user asked for a summary at the end.

=========================================================
IDENTITY
=========================================================

You are part of Kenya Campus Hub.

Your purpose is to help students learn,
solve problems, build projects,
discover opportunities and manage campus life.

`;


/*
=========================================================
DOCUMENT UPLOAD
=========================================================
*/

app.post(
    "/api/upload-document",
    upload.array(
        "documents",
        5
    ),
    async (req, res) => {

        try {

            if (
                !req.files ||
                req.files.length === 0
            ) {

                return res.status(400).json({
                    error:
                        "No documents were uploaded."
                });
            }

            const documents = [];

            for (
                const file of req.files
            ) {

                let text = "";

                /*
                -----------------------------------------
                DOCX
                -----------------------------------------
                */

                if (
                    file.mimetype ===
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                ) {

                    try {

                        const result =
                            await mammoth.extractRawText({
                                buffer:
                                    file.buffer
                            });

                        text =
                            result.value || "";

                    } catch (error) {

                        console.error(
                            "DOCX parsing error:",
                            error.message
                        );

                        text =
                            "Unable to extract text from this Word document.";
                    }
                }


                /*
                -----------------------------------------
                DOC
                -----------------------------------------
                */

                else if (
                    file.mimetype ===
                    "application/msword"
                ) {

                    text =
                        "Old .DOC files are not currently supported for text extraction. Please convert the document to .DOCX.";
                }


                /*
                -----------------------------------------
                TXT
                -----------------------------------------
                */

                else if (
                    file.mimetype ===
                    "text/plain"
                ) {

                    text =
                        file.buffer.toString(
                            "utf8"
                        );
                }


                /*
                -----------------------------------------
                CSV
                -----------------------------------------
                */

                else if (
                    file.mimetype ===
                    "text/csv"
                ) {

                    text =
                        file.buffer.toString(
                            "utf8"
                        );
                }


                /*
                -----------------------------------------
                JSON
                -----------------------------------------
                */

                else if (
                    file.mimetype ===
                    "application/json"
                ) {

                    text =
                        file.buffer.toString(
                            "utf8"
                        );
                }


                /*
                -----------------------------------------
                IMAGE
                -----------------------------------------
                */

                else if (
                    file.mimetype.startsWith(
                        "image/"
                    )
                ) {

                    text =
                        "[Image uploaded. Image analysis requires a vision-capable AI model.]";
                }


                /*
                -----------------------------------------
                UNKNOWN
                -----------------------------------------
                */

                else {

                    text =
                        `[Unsupported file: ${file.originalname}]`;
                }


                /*
                -----------------------------------------
                LIMIT DOCUMENT TEXT
                -----------------------------------------
                */

                if (
                    text.length > 100000
                ) {

                    text =
                        text.substring(
                            0,
                            100000
                        ) +
                        "\n\n[Document text truncated because it is too large.]";
                }


                documents.push({

                    name:
                        file.originalname,

                    type:
                        file.mimetype,

                    size:
                        file.size,

                    text
                });
            }


            /*
            ---------------------------------------------
            RESPONSE
            ---------------------------------------------
            */

            res.json({

                success:
                    true,

                count:
                    documents.length,

                documents
            });

        } catch (error) {

            console.error(
                "Document upload error:",
                error
            );

            res.status(500).json({

                error:
                    "Unable to process the uploaded document."
            });
        }
    }
);


/*
=========================================================
UPLOAD ERROR HANDLER
=========================================================
*/

app.use(
    "/api/upload-document",
    (error, req, res, next) => {

        console.error(
            "Upload middleware error:",
            error
        );

        if (
            error instanceof multer.MulterError
        ) {

            if (
                error.code ===
                "LIMIT_FILE_SIZE"
            ) {

                return res.status(413).json({

                    error:
                        "File is too large. Maximum file size is 10 MB."
                });
            }

            return res.status(400).json({

                error:
                    error.message
            });
        }

        if (error) {

            return res.status(400).json({

                error:
                    error.message ||
                    "File upload failed."
            });
        }

        next();
    }
);


/*
=========================================================
CAMPUS AI
STREAMING + CONVERSATION HISTORY
=========================================================
*/

app.post(
    "/api/ai",
    async (req, res) => {

        try {

            const message =
                typeof req.body?.message === "string"
                    ? req.body.message.trim()
                    : "";


            /*
            ---------------------------------------------
            VALIDATE
            ---------------------------------------------
            */

            if (!message) {

                return res.status(400).json({

                    error:
                        "Please enter a question."
                });
            }


            /*
            ---------------------------------------------
            API KEY
            ---------------------------------------------
            */

            if (
                !process.env.GROQ_API_KEY
            ) {

                console.error(
                    "GROQ_API_KEY is missing."
                );

                return res.status(500).json({

                    error:
                        "Campus AI is not configured. Add GROQ_API_KEY to your .env file."
                });
            }


            /*
            ---------------------------------------------
            CONVERSATION HISTORY
            ---------------------------------------------
            */

            const history =
                cleanAIHistory(
                    req.body?.history
                );


            /*
            ---------------------------------------------
            OPTIONAL DOCUMENT CONTENT
            ---------------------------------------------
            */

            const documents =
                Array.isArray(
                    req.body?.documents
                )
                    ? req.body.documents
                    : [];


            let documentContext = "";


            if (
                documents.length > 0
            ) {

                documentContext =
                    "\n\n===== UPLOADED DOCUMENTS =====\n";

                for (
                    const document of documents
                ) {

                    const name =
                        String(
                            document.name ||
                            "Uploaded document"
                        );

                    const text =
                        String(
                            document.text ||
                            ""
                        );

                    documentContext +=
                        `\nDOCUMENT: ${name}\n` +
                        text.substring(
                            0,
                            100000
                        ) +
                        "\n";
                }

                documentContext +=
                    "\n===== END DOCUMENTS =====\n";
            }


            /*
            ---------------------------------------------
            LIVE SITE DATA (HELB, KUCCPS, Scholarships,
            Jobs, University Alerts)
            ---------------------------------------------
            */

            let liveContext = "";

            try {

                liveContext =
                    buildLiveContext(
                        message
                    );

            } catch (error) {

                console.error(
                    "Live context error:",
                    error.message
                );
            }


            /*
            ---------------------------------------------
            BUILD MESSAGES
            ---------------------------------------------
            */

            const messages = [

                {
                    role:
                        "system",

                    content:
                        AI_SYSTEM_PROMPT +
                        liveContext
                },

                ...history,

                {
                    role:
                        "user",

                    content:
                        message +
                        documentContext
                }

            ];


            /*
            ---------------------------------------------
            LOG
            ---------------------------------------------
            */

            console.log("");

            console.log(
                "========================================"
            );

            console.log(
                "KENYA CAMPUS AI"
            );

            console.log(
                "========================================"
            );

            console.log(
                "Question:",
                message
            );

            console.log(
                "History messages:",
                history.length
            );

            console.log(
                "Documents:",
                documents.length
            );

            console.log(
                "Model:",
                GROQ_MODEL
            );


            /*
            ---------------------------------------------
            STREAM HEADERS
            ---------------------------------------------
            */

            res.status(200);

            res.setHeader(
                "Content-Type",
                "text/plain; charset=utf-8"
            );

            res.setHeader(
                "Cache-Control",
                "no-cache, no-transform"
            );

            res.setHeader(
                "Connection",
                "keep-alive"
            );

            res.setHeader(
                "X-Accel-Buffering",
                "no"
            );


            /*
            ---------------------------------------------
            GROQ STREAM
            ---------------------------------------------
            */

            const stream =
                await groq.chat.completions.create({

                    model:
                        GROQ_MODEL,

                    messages,

                    temperature:
                        0.7,

                    max_completion_tokens:
                        4096,

                    /*
                       Without these, Llama-family models on
                       Groq can fall into loops - repeating a
                       sentence, a phrase, or the same point
                       reworded, especially on longer answers.
                       frequency_penalty pushes the model away
                       from reusing tokens it has already used
                       a lot; presence_penalty pushes it away
                       from returning to a topic/phrase it has
                       already touched on at all. Values are
                       mild on purpose - too high makes answers
                       avoid ordinary repeated words (like "the"
                       or a student's own name) unnaturally.
                    */
                    frequency_penalty:
                        0.4,

                    presence_penalty:
                        0.3,

                    stream:
                        true

                });


            let totalCharacters =
                0;


            /*
            ---------------------------------------------
            SEND TOKENS
            ---------------------------------------------
            */

            for await (
                const chunk of stream
            ) {

                if (
                    res.destroyed
                ) {

                    break;
                }

                const token =
                    chunk
                        ?.choices?.[0]
                        ?.delta
                        ?.content;

                if (!token) {

                    continue;
                }

                totalCharacters +=
                    token.length;

                res.write(
                    token
                );
            }


            console.log(
                "AI response characters:",
                totalCharacters
            );


            /*
            ---------------------------------------------
            END
            ---------------------------------------------
            */

            if (
                !res.destroyed
            ) {

                res.end();
            }

        } catch (error) {

            console.error("");

            console.error(
                "========================================"
            );

            console.error(
                "KENYA CAMPUS AI ERROR"
            );

            console.error(
                "========================================"
            );

            console.error(
                error
            );


            if (
                res.headersSent
            ) {

                if (
                    !res.destroyed
                ) {

                    res.end();
                }

                return;
            }


            let status =
                500;

            let errorMessage =
                "Campus AI could not connect right now.";


            /*
            ---------------------------------------------
            401
            ---------------------------------------------
            */

            if (
                error?.status === 401
            ) {

                status =
                    401;

                errorMessage =
                    "The Groq API key is invalid or not authorized.";
            }


            /*
            ---------------------------------------------
            404
            ---------------------------------------------
            */

            else if (
                error?.status === 404
            ) {

                status =
                    502;

                errorMessage =
                    `The selected Groq model "${GROQ_MODEL}" is unavailable. Check GROQ_MODEL in your .env file.`;
            }


            /*
            ---------------------------------------------
            429
            ---------------------------------------------
            */

            else if (
                error?.status === 429
            ) {

                status =
                    429;

                errorMessage =
                    "Campus AI is temporarily rate limited. Please try again shortly.";
            }


            /*
            ---------------------------------------------
            400
            ---------------------------------------------
            */

            else if (
                error?.status === 400
            ) {

                status =
                    400;

                errorMessage =
                    "The AI request was rejected. Check the message, document size, or selected model.";
            }


            /*
            ---------------------------------------------
            500+
            ---------------------------------------------
            */

            else if (
                error?.status >= 500
            ) {

                status =
                    502;

                errorMessage =
                    "Groq is temporarily unavailable. Please try again shortly.";
            }


            res.status(
                status
            ).json({

                error:
                    errorMessage

            });
        }
    }
);


/*
=========================================================
AI HEALTH CHECK
=========================================================
*/

app.get(
    "/api/ai/status",
    (req, res) => {

        res.json({

            configured:
                Boolean(
                    process.env.GROQ_API_KEY
                ),

            model:
                GROQ_MODEL,

            streaming:
                true,

            conversationHistory:
                true,

            documentUpload:
                true,

            supportedDocuments: [
                "DOCX",
                "TXT",
                "CSV",
                "JSON"
            ],

            maxFileSizeMB:
                10,

            status:
                process.env.GROQ_API_KEY
                    ? "ready"
                    : "not-configured"

        });
    }
);


/*
=========================================================
WEBSITE STATUS
=========================================================
*/

app.get(
    "/api/status",
    (req, res) => {

        try {

            const articles =
                readArticles();

            res.json({

                status:
                    "online",

                website:
                    "Kenya Campus Hub",

                articles:
                    articles.length,

                updater:
                    "AI Automatic Updater",

                campusAI:
                    process.env.GROQ_API_KEY
                        ? "configured"
                        : "not configured",

                campusAIModel:
                    GROQ_MODEL,

                streamingAI:
                    true,

                conversationMemory:
                    true,

                documentUpload:
                    true,

                updateIntervalMinutes:
                    UPDATE_INTERVAL,

                serverTime:
                    new Date().toISOString()

            });

        } catch (error) {

            console.error(
                "Status error:",
                error
            );

            res.status(500).json({

                error:
                    "Unable to get server status."
            });
        }
    }
);


/*
=========================================================
ARTICLE PAGE
=========================================================
*/

app.get(
    "/article.html",
    (req, res) => {

        res.sendFile(
            path.join(
                publicFolder,
                "article.html"
            )
        );
    }
);


/*
=========================================================
HOME PAGE
=========================================================
*/

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                publicFolder,
                "index.html"
            )
        );
    }
);


/*
=========================================================
API 404
=========================================================
*/

app.use(
    "/api",
    (req, res) => {

        res.status(404).json({

            error:
                "API endpoint not found",

            path:
                req.originalUrl

        });
    }
);


/*
=========================================================
GENERAL ERROR HANDLER
=========================================================
*/

app.use(
    (error, req, res, next) => {

        console.error(
            "Server error:",
            error
        );

        if (
            res.headersSent
        ) {

            return next(error);
        }

        res.status(500).json({

            error:
                "Internal server error."

        });
    }
);


/*
=========================================================
AUTOMATIC AI UPDATER
=========================================================
*/

function runUpdater() {

    console.log("");

    console.log(
        "========================================"
    );

    console.log(
        "STARTING AUTOMATIC AI UPDATE"
    );

    console.log(
        "========================================"
    );


    const updaterPath =
        path.join(
            __dirname,
            "ai-updater.js"
        );


    if (
        !fs.existsSync(
            updaterPath
        )
    ) {

        console.warn(
            "ai-updater.js was not found."
        );

        return;
    }


    const updater =
        spawn(
            process.execPath,
            [
                updaterPath
            ],
            {
                stdio:
                    "inherit"
            }
        );


    updater.on(
        "error",
        error => {

            console.error(
                "AI updater failed to start:",
                error.message
            );
        }
    );


    updater.on(
        "close",
        code => {

            console.log(
                `AI updater finished with code ${code}`
            );
        }
    );
}


/*
=========================================================
START SERVER
=========================================================
*/

server.listen(
        PORT,
        () => {

            console.log("");

            console.log(
                "========================================"
            );

            console.log(
                "       KENYA CAMPUS HUB"
            );

            console.log(
                "========================================"
            );

            console.log(
                `Website: http://localhost:${PORT}`
            );

            console.log(
                `API: http://localhost:${PORT}/api/content`
            );

            console.log(
                `Search: http://localhost:${PORT}/api/search?q=HELB`
            );

            console.log(
                `Status: http://localhost:${PORT}/api/status`
            );

            console.log(
                `AI: http://localhost:${PORT}/api/ai`
            );

            console.log(
                `AI Status: http://localhost:${PORT}/api/ai/status`
            );

            console.log(
                `Upload: http://localhost:${PORT}/api/upload-document`
            );

            console.log(
                `AI Model: ${GROQ_MODEL}`
            );

            console.log(
                "AI Streaming: ENABLED"
            );

            console.log(
                "Conversation History: ENABLED"
            );

            console.log(
                "Document Upload: ENABLED"
            );

            console.log(
                "Maximum File Size: 10 MB"
            );

            console.log(
                `Automatic updates: Every ${UPDATE_INTERVAL} minutes`
            );

            console.log(
                "========================================"
            );


            /*
            -----------------------------------------
            FIRST AUTOMATIC UPDATE
            -----------------------------------------
            */

            runUpdater();
            runUniversityRumoursAutoUpdate();


            /*
            -----------------------------------------
            REPEATED UPDATES
            -----------------------------------------
            */

            setInterval(
                runUpdater,
                UPDATE_INTERVAL *
                60 *
                1000
            );

            setInterval(
                runUniversityRumoursAutoUpdate,
                UNIVERSITY_RUMOURS_CACHE_TIME
            );
        }
    );


/*
=========================================================
SERVER ERROR HANDLING
=========================================================
*/

server.on(
    "error",
    error => {

        if (
            error.code ===
            "EADDRINUSE"
        ) {

            console.error(
                `Port ${PORT} is already in use.`
            );

            console.error(
                "Close the other server or change PORT in .env."
            );

            process.exit(1);
        }


        console.error(
            "Server error:",
            error
        );
    }
);


/*
=========================================================
GRACEFUL SHUTDOWN
=========================================================
*/

function shutdown(signal) {

    console.log(
        `\n${signal} received. Shutting down server...`
    );


    server.close(
        () => {

            console.log(
                "Server stopped."
            );

            process.exit(0);
        }
    );
}


process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);