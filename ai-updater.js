import "dotenv/config";

import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";
import Groq from "groq-sdk";
import { fileURLToPath } from "url";

// Cerebras' API is OpenAI-compatible, so it's used through the same
// "openai" SDK package pointed at Cerebras' base URL instead of a
// dedicated cerebras package.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// ========================================
// MULTI-PROVIDER AI CLIENTS
// ========================================
// Each category below is assigned a "provider" so that different
// categories use different AI accounts/rate limits. This means one
// provider running out of quota only affects the categories assigned
// to it, not the whole engine.
//
// Supported providers: "openai", "groq", "gemini", "perplexity", "cohere",
// "exa", "cerebras", "tavily"
// Only the providers you actually configure API keys for are used —
// any category whose provider key is missing is skipped with a warning.

const openaiClient =
    process.env.OPENAI_API_KEY
        ? new OpenAI({
              apiKey: process.env.OPENAI_API_KEY
          })
        : null;

// Groq is not currently assigned to a category — it's still
// initialized and available if you want to use it elsewhere.
const groqClient =
    process.env.GROQ_API_KEY
        ? new Groq({
              apiKey: process.env.GROQ_API_KEY
          })
        : null;

const cerebrasClient =
    process.env.CEREBRAS_API_KEY
        ? new OpenAI({
              apiKey: process.env.CEREBRAS_API_KEY,
              baseURL: "https://api.cerebras.ai/v1"
          })
        : null;

const OPENAI_MODEL =
    process.env.OPENAI_MODEL ||
    "gpt-5.6-luna";

// Groq's "compound" models can browse the web on their own as part of
// answering, which is what lets Groq stand in for a search-capable model.
const GROQ_SEARCH_MODEL =
    process.env.GROQ_SEARCH_MODEL ||
    "groq/compound";

const GROQ_TEXT_MODEL =
    process.env.GROQ_TEXT_MODEL ||
    "llama-3.3-70b-versatile";

// Cerebras runs open-weight models on its own inference hardware for
// very fast responses. Unlike Groq's "compound" model or Exa, it has
// NO built-in web browsing/search — it only answers from what's in
// the prompt. See the note above HELB's config below for why that
// matters for this category.
//
// Default model confirmed against a real account's GET /v1/models
// response (09/2026): available models were gpt-oss-120b,
// qwen-3.8-27b, gemma-4-31b - NOT llama-3.3-70b, which is what this
// default used to be and what was causing every Cerebras call to
// 404 with "Model does not exist or you do not have access to it."
// Cerebras's model lineup changes over time and can differ by
// account/plan, so if this ever 404s again, run this to see what's
// actually available and update CEREBRAS_MODEL in .env (no code
// change needed) to match:
//
//   node -e "fetch('https://api.cerebras.ai/v1/models',{headers:{Authorization:'Bearer '+process.env.CEREBRAS_API_KEY}}).then(r=>r.text()).then(console.log)"
//
const CEREBRAS_MODEL =
    process.env.CEREBRAS_MODEL ||
    "gpt-oss-120b";

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY ||
    "";

const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-2.0-flash";

const PERPLEXITY_API_KEY =
    process.env.PERPLEXITY_API_KEY ||
    "";

const PERPLEXITY_MODEL =
    process.env.PERPLEXITY_MODEL ||
    "sonar";

// Cohere is no longer assigned to a category (University Alerts moved
// to Groq) — it's still initialized and available if you want to use
// it elsewhere.
const COHERE_API_KEY =
    process.env.COHERE_API_KEY ||
    "";

const COHERE_MODEL =
    process.env.COHERE_MODEL ||
    "command-r-plus";

// Exa is the 6th provider. It is a genuinely free (20,000 requests/
// month on the free tier), search-native API rather than a general
// chat model — its /answer endpoint runs a real web search and has an
// LLM compose the answer from the results, which is exactly the
// "search official domains, return findings" job this engine needs.
const EXA_API_KEY =
    process.env.EXA_API_KEY ||
    "";

const EXA_ANSWER_URL =
    "https://api.exa.ai/answer";

// Exa's /search endpoint (as opposed to /answer) does NOT use an LLM
// to compose anything - it just returns raw ranked search results
// (title, url, publishedDate, page text). Used instead of /answer for
// the discovery phase below, specifically to avoid ever needing an AI
// to hand back structured JSON (see the long comment above callExa()
// for why that was unreliable).
const EXA_SEARCH_URL =
    "https://api.exa.ai/search";

// Tavily is the 7th provider. Like Exa, it is search-native rather
// than a general chat model: its /search endpoint can run a real web
// search restricted to specific domains and, with
// include_answer: true, has it own LLM compose a synthesized answer
// from the results in a single call — no separate compose model
// needed. Generous free tier (1,000 requests/month). Dedicated to
// University Alerts so campus strikes/closures get live, current
// results without competing with any other category's quota.
const TAVILY_API_KEY =
    process.env.TAVILY_API_KEY ||
    "";

const TAVILY_SEARCH_URL =
    "https://api.tavily.com/search";

const availableProviders = {
    openai: Boolean(openaiClient),
    groq: Boolean(groqClient),
    gemini: Boolean(GEMINI_API_KEY),
    perplexity: Boolean(PERPLEXITY_API_KEY),
    cohere: Boolean(COHERE_API_KEY),
    exa: Boolean(EXA_API_KEY),
    cerebras: Boolean(cerebrasClient),
    tavily: Boolean(TAVILY_API_KEY)
};


// ========================================
// RATE-LIMIT-SAFE PACING
// ========================================
// A small delay is inserted between each category and between each
// item processed within a category, so a run never fires a burst of
// requests fast enough to trip a provider's per-minute limit.

const DELAY_BETWEEN_SOURCES_MS =
    Number(
        process.env.UPDATE_DELAY_MS || 5000
    );

const DELAY_BETWEEN_ITEMS_MS =
    Number(
        process.env.ITEM_DELAY_MS || 3000
    );

function sleep(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


// ========================================
// EXPIRY FALLBACKS (days)
// ========================================
// If the AI doesn't return an explicit expiryDate for an item (or it's
// clearly evergreen/unknown), articles fall back to a category-based
// maximum age so old, stale entries still get cleaned up automatically.

const FALLBACK_EXPIRY_DAYS = {

    "HELB": 150,

    "KUCCPS": 120,

    "Scholarships": 120,

    "Jobs": 45,

    "University Alerts": 30
};

const sourcesFile =
    path.join(__dirname, "sources.json");

const dataFolder =
    path.join(__dirname, "data");

const articlesFile =
    path.join(dataFolder, "articles.json");


// ========================================
// CONFIGURATION
// ========================================
// "provider" spreads categories across different AI accounts so a
// rate limit on one account doesn't block every category.

const sourceConfigs = [
    {
        name: "HELB",
        category: "HELB",
        // Exa's /answer endpoint runs a real web search against
        // helb.co.ke before answering, so deadline/disbursement
        // announcements are picked up live instead of only being as
        // fresh as whatever happened to already be in the prompt
        // (which was the problem with Cerebras, which has no web
        // search of its own).
        provider: "exa",
        domains: ["helb.co.ke"],
        topics: [
            "first time undergraduate loan applications",
            "subsequent loan applications",
            "TVET loans",
            "HELB scholarships",
            "bursaries",
            "postgraduate scholarships",
            "loan disbursement",
            "upkeep",
            "tuition",
            "loan allocation",
            "loan status",
            "appeals",
            "reviews",
            "deadlines",
            "student portal",
            "HELB press releases",
            "new student funding announcements"
        ]
    },

    {
        name: "KUCCPS",
        category: "KUCCPS",
        provider: "gemini",
        domains: ["kuccps.net"],
        topics: [
            "university applications",
            "TVET applications",
            "course applications",
            "course revision",
            "second revision",
            "placement",
            "placement results",
            "student transfers",
            "KMTC applications",
            "intakes",
            "application deadlines",
            "KUCCPS news",
            "new placement announcements"
        ]
    },

    {
        name: "Scholarships",
        category: "Scholarships",
        provider: "perplexity",
        domains: [
            "helb.co.ke",
            "education.go.ke",
            "universitiesfund.go.ke",
            "ac.ke",
            "chevening.org",
            "daad.de",
            "mastercardfdn.org",
            "erasmus-plus.ec.europa.eu",
            "commonwealthscholarships.org",
            "fulbrightonline.org"
        ],
        topics: [
            "Kenya government scholarships",
            "university scholarships",
            "international scholarships",
            "fully funded scholarships",
            "partial scholarships",
            "undergraduate scholarships",
            "postgraduate scholarships",
            "Masters scholarships",
            "PhD scholarships",
            "fellowships",
            "scholarship deadlines",
            "scholarship requirements",
            "scholarship eligibility",
            "scholarship application",
            "new scholarship opportunities",
            "2026 scholarships",
            "2027 scholarships",
            "scholarship extensions",
            "scholarship deadline changes",
            "student funding opportunities"
        ]
    },

    {
        name: "Jobs",
        category: "Jobs",
        provider: "openai",
        domains: [
            "publicservice.go.ke",
            "pscims.publicservice.go.ke",
            "go.ke",
            "ac.ke"
        ],
        topics: [
            "government jobs",
            "private jobs",
            "internships",
            "attachments",
            "graduate trainee jobs",
            "entry level jobs",
            "university jobs",
            "student jobs",
            "remote jobs",
            "new vacancies",
            "job closing dates"
        ]
    },

    {
        name: "University Alerts",
        category: "University Alerts",
        // Tavily runs a real web search restricted to the domains
        // below and composes a synthesized answer in one call. This
        // category needs live search — plain Cerebras (the previous
        // provider here) has no browsing of its own, so it could
        // never confirm a strike/closure is actually current (see the
        // "only report it if a credible source describes it as
        // current" rule below), and every item ended up filtered out.
        // CEREBRAS_API_KEY is also recommended (not required) alongside
        // TAVILY_API_KEY: Tavily's synthesized answer is a natural-
        // language reply, not guaranteed valid JSON, so Cerebras is
        // used as a fallback to compose strict JSON from Tavily's raw
        // findings when needed (see PROVIDER: TAVILY below).
        provider: "tavily",
        domains: [
            "ac.ke",
            "education.go.ke",
            "cue.or.ke",
            "uasu.or.ke",
            "nation.africa",
            "standardmedia.co.ke",
            "the-star.co.ke",
            "tuko.co.ke",
            "citizen.digital",
            "capitalfm.co.ke"
        ],
        topics: [
            "university strikes",
            "lecturer strikes",
            "UASU strike",
            "university staff strikes",
            "student unrest",
            "student demonstrations",
            "university closures",
            "suspension of learning",
            "semester postponement",
            "exam postponement",
            "academic calendar changes",
            "university reopening dates",
            "university closing dates",
            "senate announcements",
            "official university circulars",
            "vice chancellor statements",
            "campus insecurity",
            "campus safety alerts",
            "sudden fee structure changes",
            "weather related university closures",
            "health related university closures",
            "ministry of education directives on universities",
            "CUE directives",
            "university mergers",
            "accreditation changes"
        ]
    }
];


// ========================================
// FILE FUNCTIONS
// ========================================

function ensureDataFolder() {

    if (!fs.existsSync(dataFolder)) {
        fs.mkdirSync(
            dataFolder,
            {
                recursive: true
            }
        );
    }

    if (!fs.existsSync(articlesFile)) {

        fs.writeFileSync(
            articlesFile,
            "[]",
            "utf8"
        );
    }
}


function loadArticles() {

    ensureDataFolder();

    try {

        const data =
            fs.readFileSync(
                articlesFile,
                "utf8"
            );

        const articles =
            JSON.parse(data);

        return Array.isArray(articles)
            ? articles
            : [];

    } catch (error) {

        console.error(
            "Could not read articles:",
            error.message
        );

        return [];
    }
}


function saveArticles(
    articles
) {

    ensureDataFolder();

    fs.writeFileSync(
        articlesFile,
        JSON.stringify(
            articles,
            null,
            2
        ),
        "utf8"
    );
}


// ========================================
// EXPIRE OLD / OUTDATED ARTICLES
// ========================================
// An article is removed once it passes its expiresAt date (an explicit
// deadline/reopening date the AI extracted from the official source),
// or — if no such date was ever given — once it's older than the
// category's fallback maximum age. Articles with neither an expiresAt
// nor a determinable age (e.g. missing "date") are kept, since we
// can't safely judge them as stale.

function pruneExpiredArticles(
    articles
) {

    const now =
        new Date();

    return articles.filter(
        article => {

            // Older articles were written by a previous version of
            // this script and use "deadline" instead of "expiresAt".
            // Without this fallback those articles never match the
            // check below and are treated as if they never expire.
            const explicitExpiry =
                article.expiresAt ||
                article.deadline;

            if (explicitExpiry) {

                const expiry =
                    new Date(
                        explicitExpiry
                    );

                if (
                    !isNaN(expiry) &&
                    expiry < now
                ) {

                    console.log(
                        `EXPIRED (explicit date): ${article.title}`
                    );

                    return false;
                }

                return true;
            }


            const fallbackDays =
                FALLBACK_EXPIRY_DAYS[
                    article.category
                ];

            if (!fallbackDays) {

                return true;
            }

            // Same legacy-schema issue as above: older articles use
            // "publishedDate"/"updatedAt" instead of "date"/"updated"/
            // "lastChecked". Falling back through both sets of names
            // means age-based expiry actually applies to them too.
            const reference =
                article.date ||
                article.updated ||
                article.lastChecked ||
                article.publishedDate ||
                article.updatedAt;

            if (!reference) {

                return true;
            }

            const referenceDate =
                new Date(reference);

            if (isNaN(referenceDate)) {

                return true;
            }

            const ageMs =
                now - referenceDate;

            const ageDays =
                ageMs /
                (1000 * 60 * 60 * 24);

            if (ageDays > fallbackDays) {

                console.log(
                    `EXPIRED (age > ${fallbackDays}d): ${article.title}`
                );

                return false;
            }

            return true;
        }
    );
}


// ========================================
// ID GENERATOR
// ========================================

function makeId(
    title,
    url
) {

    return crypto
        .createHash("sha256")
        .update(
            `${title}|${url}`
        )
        .digest("hex")
        .substring(0, 16);
}


// ========================================
// CLEAN AI JSON
// ========================================

function parseAIJson(
    text
) {

    if (!text) {
        throw new Error(
            "AI returned empty response"
        );
    }

    let cleaned =
        String(text)
            .trim();

    cleaned =
        cleaned
            .replace(/^```json/i, "")
            .replace(/^```/i, "")
            .replace(/```$/i, "")
            .trim();

    const firstBrace =
        cleaned.indexOf("{");

    const lastBrace =
        cleaned.lastIndexOf("}");

    if (
        firstBrace !== -1 &&
        lastBrace !== -1
    ) {

        cleaned =
            cleaned.substring(
                firstBrace,
                lastBrace + 1
            );
    }

    return JSON.parse(
        cleaned
    );
}


// ========================================
// DOMAIN SAFETY FILTER
// ========================================
// OpenAI's web_search tool can restrict results to allowed_domains at
// the API level. Groq/Gemini/Perplexity cannot be restricted that way,
// so as a safety net we drop any item whose sourceUrl doesn't match one
// of the configured domains after the fact.

function hostnameMatchesDomains(
    url,
    domains
) {

    if (!url) {
        return false;
    }

    let hostname = "";

    try {

        hostname =
            new URL(url)
                .hostname
                .toLowerCase();

    } catch (error) {

        hostname =
            String(url)
                .toLowerCase();
    }

    return domains.some(
        domain =>
            hostname.includes(
                domain.toLowerCase()
            )
    );
}


function filterItemsByDomain(
    items,
    domains
) {

    if (!Array.isArray(items)) {
        return [];
    }

    return items.filter(
        item => {

            const matches =
                hostnameMatchesDomains(
                    item?.sourceUrl,
                    domains
                );

            if (!matches) {

                console.log(
                    `Dropped off-domain item: ${item?.title || "(untitled)"}`
                );
            }

            return matches;
        }
    );
}


// ========================================
// PROVIDER: OPENAI
// ========================================

async function searchWithOpenAI(
    prompt,
    domains
) {

    const response =
        await openaiClient.responses.create({

            model: OPENAI_MODEL,

            tools: [
                {
                    type: "web_search",

                    filters: {
                        allowed_domains: domains
                    },

                    search_context_size: "high"
                }
            ],

            input: prompt
        });

    return response.output_text;
}


async function textWithOpenAI(
    prompt
) {

    const response =
        await openaiClient.responses.create({

            model: OPENAI_MODEL,

            input: prompt
        });

    return response.output_text;
}


// ========================================
// PROVIDER: GROQ
// ========================================
// Groq's "compound" models can browse the web on their own while
// answering, so the domain restriction and "official sources only"
// instructions are enforced through the prompt text, with a hard
// domain filter applied afterward as a safety net.

async function searchWithGroq(
    prompt
) {

    const response =
        await groqClient.chat.completions.create({

            model: GROQ_SEARCH_MODEL,

            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ]
        });

    return response.choices?.[0]?.message?.content || "";
}


async function textWithGroq(
    prompt
) {

    const response =
        await groqClient.chat.completions.create({

            model: GROQ_TEXT_MODEL,

            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ]
        });

    return response.choices?.[0]?.message?.content || "";
}


// ========================================
// PROVIDER: CEREBRAS
// ========================================
// Cerebras has no web-browsing/search mode of its own (no "compound"
// model like Groq's), so both functions just run the prompt straight
// through chat completions. The domain restriction and "official
// sources only" instructions rely entirely on the prompt text here —
// there's no live-browsing safety net like Exa/Groq-compound provide.

async function searchWithCerebras(
    prompt
) {

    const response =
        await cerebrasClient.chat.completions.create({

            model: CEREBRAS_MODEL,

            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ]
        });

    return response.choices?.[0]?.message?.content || "";
}


async function textWithCerebras(
    prompt
) {

    const response =
        await cerebrasClient.chat.completions.create({

            model: CEREBRAS_MODEL,

            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ]
        });

    return response.choices?.[0]?.message?.content || "";
}


// ========================================
// PROVIDER: GEMINI
// ========================================
// Uses Gemini's REST API directly (no extra package needed).
// Search variant enables Google Search grounding; text variant does not.

async function callGemini(
    prompt,
    useSearchGrounding
) {

    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const body = {

        contents: [
            {
                parts: [
                    { text: prompt }
                ]
            }
        ]
    };

    if (useSearchGrounding) {

        body.tools = [
            { google_search: {} }
        ];
    }

    const response =
        await fetch(
            url,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify(body)
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            data?.error?.message ||
            `Gemini request failed (${response.status})`
        );
    }

    const parts =
        data?.candidates?.[0]?.content?.parts || [];

    return parts
        .map(part => part.text || "")
        .join("\n");
}


async function searchWithGemini(
    prompt
) {

    return callGemini(prompt, true);
}


async function textWithGemini(
    prompt
) {

    return callGemini(prompt, false);
}


// ========================================
// PROVIDER: PERPLEXITY
// ========================================
// Perplexity's "sonar" models are always web-connected, which covers
// both the search step and (with re-verification as a side benefit)
// the article-writing step.

async function callPerplexity(
    prompt
) {

    const response =
        await fetch(
            "https://api.perplexity.ai/chat/completions",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${PERPLEXITY_API_KEY}`
                },

                body: JSON.stringify({

                    model: PERPLEXITY_MODEL,

                    messages: [
                        {
                            role: "user",
                            content: prompt
                        }
                    ]
                })
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            data?.error?.message ||
            `Perplexity request failed (${response.status})`
        );
    }

    return data?.choices?.[0]?.message?.content || "";
}


async function searchWithPerplexity(
    prompt
) {

    return callPerplexity(prompt);
}


async function textWithPerplexity(
    prompt
) {

    return callPerplexity(prompt);
}


// ========================================
// PROVIDER: COHERE
// ========================================
// Cohere's Chat API supports a built-in "web-search" connector, which
// is what lets it act as a search-capable provider. Dedicated to
// University Alerts so campus strikes/closures never compete with
// HELB (or any other category) for quota.

async function callCohere(
    prompt,
    useWebSearch
) {

    const body = {

        model: COHERE_MODEL,

        message: prompt
    };

    if (useWebSearch) {

        body.connectors = [
            { id: "web-search" }
        ];
    }

    const response =
        await fetch(
            "https://api.cohere.com/v1/chat",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${COHERE_API_KEY}`
                },

                body: JSON.stringify(body)
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            data?.message ||
            `Cohere request failed (${response.status})`
        );
    }

    return data?.text || "";
}


async function searchWithCohere(
    prompt
) {

    // Step 1: load a draft answer using Cohere's web-search connector.
    const draft =
        await callCohere(
            prompt,
            true
        );

    // Step 2: send the draft back to Cohere to be checked and
    // corrected before it is treated as final. This catches malformed
    // JSON, unsupported claims, and invented details that can slip
    // into a first-pass web-search answer.
    try {

        const corrected =
            await correctCohereDraft(
                prompt,
                draft
            );

        return corrected;

    } catch (correctionError) {

        console.error(
            "Cohere correction pass failed, using original draft:",
            correctionError.message
        );

        return draft;
    }
}


async function correctCohereDraft(
    originalPrompt,
    draftAnswer
) {

    const correctionPrompt =
`You are reviewing your OWN previous answer for accuracy before it gets used.

ORIGINAL REQUEST YOU WERE ANSWERING:
${originalPrompt}

YOUR DRAFT ANSWER:
${draftAnswer}

Review the draft carefully and correct it:
- Fix any invalid or malformed JSON so it exactly matches the structure the original request asked for.
- Remove any item whose facts are not clearly supported by an official or reputable source found in your search.
- Remove any invented dates, amounts, requirements, or other details.
- Do not add brand-new items that were not already in the draft.
- If the draft is already correct as-is, return it unchanged.

Return ONLY the corrected, valid JSON — no explanation, no commentary, nothing before or after it.`;

    return callCohere(
        correctionPrompt,
        false
    );
}


async function textWithCohere(
    prompt
) {

    return callCohere(prompt, false);
}


// ========================================
// PROVIDER: EXA
// ========================================
// Exa's /answer endpoint isn't a general chat model — it runs a real
// web search and has an LLM compose the answer (with citations) from
// whatever it finds. That's exactly the "search official domains,
// return findings as JSON" job this engine needs, and it's genuinely
// free up to a generous monthly request quota. Dedicated to HELB.
//
// Exa doesn't reliably follow the "respond only in JSON" instruction
// baked into the prompt - it sometimes just answers conversationally
// instead (this is what caused "Unexpected token 'T', "The Higher"...
// is not valid JSON" - Exa replied in plain English starting with
// "The Higher Education Loans Board...", so there was no {...} block
// for parseAIJson() to extract, and JSON.parse() choked on the first
// word of the prose).
//
// Rather than bring in a second provider to compose JSON from Exa's
// prose (the same single-point-of-failure shape that took down
// University Alerts when Cerebras returned a 402), the correction
// pass here stays on Exa itself - one extra /answer call, same
// provider, same free quota, no new dependency. This mirrors the
// Cohere provider's own draft-then-self-correct pattern below.

async function fetchExaAnswer(
    query
) {

    const response =
        await fetch(
            EXA_ANSWER_URL,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": EXA_API_KEY
                },

                body: JSON.stringify({
                    query,
                    text: true
                })
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            data?.error ||
            data?.message ||
            `Exa request failed (${response.status})`
        );
    }

    if (
        typeof data?.answer === "string"
    ) {

        return data.answer;
    }

    if (
        data?.answer &&
        typeof data.answer === "object"
    ) {

        return JSON.stringify(
            data.answer
        );
    }

    return "";
}


function answerLooksLikeJson(
    answer
) {

    return Boolean(
        answer &&
        answer.includes("{") &&
        answer.includes("}")
    );
}


async function callExa(
    prompt
) {

    const draft =
        await fetchExaAnswer(
            prompt
        );

    if (
        answerLooksLikeJson(draft)
    ) {

        return draft;
    }

    // Draft came back as prose, not JSON. Send Exa its own findings
    // back and ask it to compose ONLY the required JSON from them -
    // no new search, no commentary. Same provider, one extra call.
    const composePrompt =
        `${prompt}\n\n` +
        `===== YOUR OWN PRIOR FINDINGS (compose ONLY the JSON object ` +
        `described above from this text - do not search again, do not ` +
        `add any explanation before or after the JSON) =====\n` +
        `${draft}\n` +
        `===== END FINDINGS =====`;

    try {

        const corrected =
            await fetchExaAnswer(
                composePrompt
            );

        if (
            answerLooksLikeJson(corrected)
        ) {

            return corrected;
        }

        console.error(
            "Exa's JSON-compose retry still returned plain text - " +
            "treating as no new items this run. Raw answer: " +
            `"${draft.slice(0, 120)}${draft.length > 120 ? "..." : ""}"`
        );

    } catch (error) {

        console.error(
            "Exa's JSON-compose retry failed - treating as no new " +
            `items this run: ${error.message}`
        );
    }

    // Existing articles are untouched either way - this just keeps
    // the failure readable and non-fatal instead of letting raw
    // prose reach JSON.parse() and throw a confusing low-level error.
    return JSON.stringify(
        { items: [] }
    );
}


async function searchWithExa(
    prompt
) {

    return callExa(prompt);
}


async function textWithExa(
    prompt
) {

    return callExa(prompt);
}


// ========================================
// EXA DISCOVERY (RAW SEARCH, NO AI JSON)
// ========================================
// The self-correcting JSON-compose retry above still couldn't get Exa
// to reliably return JSON, even when explicitly handed its own prior
// findings and asked to reformat them (see callExa()). That's a real,
// structural limit of the /answer endpoint - it's built to write
// natural-language answers with citations, not to follow strict
// output-format instructions the way a chat-completion model does.
//
// So the DISCOVERY phase for HELB stops asking Exa for JSON entirely.
// It hits Exa's /search endpoint instead - a plain search API with no
// LLM composition step at all - and this file builds the item objects
// itself in code from the raw results below. There's nothing left for
// Exa to get "wrong": no JSON for it to fail to produce.

function buildExaSearchQuery(
    category,
    topics
) {

    const query =
        `${category} Kenya ` +
        (
            Array.isArray(topics)
                ? topics.slice(0, 4).join(" ")
                : ""
        );

    return query
        .trim()
        .slice(0, 300);
}


async function callExaSearch(
    query,
    domains
) {

    const body = {

        query,

        numResults: 8,

        contents: {
            text: {
                maxCharacters: 1500
            }
        }
    };

    if (
        Array.isArray(domains) &&
        domains.length
    ) {

        body.includeDomains = domains;
    }

    const response =
        await fetch(
            EXA_SEARCH_URL,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": EXA_API_KEY
                },

                body: JSON.stringify(body)
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            data?.error ||
            data?.message ||
            `Exa search request failed (${response.status})`
        );
    }

    return Array.isArray(data?.results)
        ? data.results
        : [];
}


async function discoverWithExaSearch(
    config,
    existingArticles
) {

    const existingUrls =
        new Set(
            existingArticles
                .filter(
                    article =>
                        article.category ===
                        config.category
                )
                .map(
                    article =>
                        String(
                            article.sourceUrl || ""
                        )
                            .trim()
                            .toLowerCase()
                )
        );

    const query =
        buildExaSearchQuery(
            config.category,
            config.topics
        );

    let results;

    try {

        results =
            await callExaSearch(
                query,
                config.domains
            );

    } catch (error) {

        console.error(
            `Search failed for ${config.name} (exa):`,
            error.message
        );

        return [];
    }

    const seen = new Set();

    const items = [];

    for (
        const result of results
    ) {

        const url =
            String(
                result.url || ""
            )
                .trim();

        if (!url || !result.title) {
            continue;
        }

        const key =
            url.toLowerCase();

        // Skip duplicate results within this one run. Results that
        // already match an existing article still get passed through -
        // if the page's content hasn't actually changed, the
        // sourceHash comparison downstream in processSource() will
        // skip it as "No change" without spending an article-writing
        // call on it.
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);

        const text =
            String(
                result.text || ""
            )
                .trim();

        items.push({

            title:
                result.title,

            sourceUrl:
                url,

            publishedDate:
                result.publishedDate ||
                null,

            updatedDate:
                null,

            expiryDate:
                null,

            topic:
                config.category,

            importance:
                "high",

            reason:
                existingUrls.has(key)
                    ? "Existing HELB source page - checking for changes"
                    : "New HELB source page found via Exa search",

            scope:
                null,

            facts:
                text
                    ? [text]
                    : []
        });
    }

    console.log(
        `Found ${items.length} candidate item(s) (exa).`
    );

    return items;
}


// ========================================
// EXA ARTICLE WRITING (PLAIN PROSE, NO AI JSON)
// ========================================
// Same reasoning as discovery above: don't ask Exa's /answer endpoint
// to hand back JSON - ask it to write the article as plain prose
// (something it has already demonstrated it does well, unprompted,
// in the raw answers logged during the failed JSON attempts) and
// build the article object around that prose in code instead.

async function writeExaArticleProse(
    item,
    config,
    existing
) {

    const prompt = `You are the senior student-information writer for Kenya Campus Hub.

Write a detailed, accurate, useful PLAIN-TEXT article for Kenyan university, college and TVET students about the following.

CATEGORY:
${config.category}

TITLE:
${item.title}

OFFICIAL SOURCE:
${item.sourceUrl}

VERIFIED FACTS FOUND ON THE OFFICIAL PAGE:
${(item.facts || []).join("\n\n") || "(none extracted - rely only on what you can verify from the official source above)"}
${
    existing
        ? `\nPREVIOUS VERSION OF THIS ARTICLE (update it - keep what's still accurate, replace what's changed, add what's new, remove what's outdated):\n${existing.content || ""}`
        : ""
}

RULES:

- Use ONLY facts supported by the text above. Do not invent dates, amounts, eligibility requirements, application links, or contact information.
- Write at least 500-700 words of substantive content, organized under clear section headings.
- Cover, where the facts support it: what this is about, who is affected, key details, eligibility/requirements, important dates and deadlines, how to apply or access the service, and what students should do now.
- If something isn't covered by the facts above, say students should verify it on the official source rather than guessing.
- Do NOT wrap the article in JSON, markdown code fences, or any structural formatting other than plain section headings and paragraphs. Write ONLY the article itself - no preamble like "Here is the article".`;

    const prose =
        String(
            await fetchExaAnswer(
                prompt
            ) || ""
        )
            .trim();

    if (!prose) {
        return null;
    }

    const firstParagraph =
        prose
            .split(/\n{2,}/)[0]
            .replace(/\n/g, " ")
            .trim();

    const summary =
        firstParagraph.length > 400
            ? `${firstParagraph.slice(0, 400)}…`
            : firstParagraph;

    return {

        title:
            item.title,

        summary,

        content:
            prose,

        source:
            config.name,

        sourceUrl:
            item.sourceUrl,

        publishedDate:
            item.publishedDate ||
            null,

        expiresAt:
            item.expiryDate ||
            null
    };
}


// ========================================
// PROVIDER: TAVILY
// ========================================
// Tavily's /search endpoint (include_answer: true) runs a real web
// search — optionally restricted to specific domains via
// include_domains — and has its own LLM compose a synthesized answer
// from whatever it finds, all in a single call.
//
// That synthesized answer is a natural-language reply to the query,
// NOT a structured-output call — it doesn't reliably obey "return
// only valid JSON" instructions buried in a long prompt (Exa's
// /answer endpoint has the exact same limitation — see the HELB
// failures in the logs: "Unexpected token 'T', "The 2026/2"...").
// So if Tavily's answer doesn't already look like it contains a JSON
// object, this falls back to composing one with Cerebras from
// Tavily's raw findings — the same pattern the old Brave+Cerebras
// pairing used. This only costs a second API call when the direct
// answer wasn't already usable, and if Cerebras isn't configured it
// just returns the raw answer as before (same behavior as before this
// fallback existed).

// Tavily (and FastAPI-style APIs generally) can return an error as a
// plain string, a nested {error: "..."} / {message: "..."} object, or
// an array of validation-error objects like
// [{msg: "...", loc: [...], type: "..."}]. Passing any of those
// non-string shapes straight to `new Error(...)` just stringifies to
// "[object Object]", hiding the actual reason. This pulls out a
// readable message from whichever shape came back.
function extractApiErrorMessage(
    data,
    fallback
) {

    const candidate =
        data?.error ??
        data?.detail ??
        data?.message;

    if (typeof candidate === "string" && candidate.trim()) {

        return candidate;
    }

    if (Array.isArray(candidate) && candidate.length) {

        return candidate
            .map(
                item =>
                    (typeof item === "string" && item) ||
                    item?.msg ||
                    item?.message ||
                    JSON.stringify(item)
            )
            .join("; ");
    }

    if (candidate && typeof candidate === "object") {

        return (
            candidate.error ||
            candidate.message ||
            candidate.msg ||
            JSON.stringify(candidate)
        );
    }

    return fallback;
}


// Tavily's `query` field is a real search-engine query box, not an
// LLM instruction slot - the API hard-rejects anything over 1500
// characters ("Query length cannot be greater than 100"... wait, no,
// that message was NewsData's; Tavily's own limit is 1500, and it
// was still being blown past because the full multi-thousand-
// character category prompt (rules, JSON schema, existing-articles
// dump) was being sent as the literal query). This truncates/cleans
// whatever gets passed in as a hard safety net, but callers should
// always pass a genuinely short, human-search-style query built by
// buildTavilySearchQuery() below rather than relying on this cutoff.
const TAVILY_MAX_QUERY_LENGTH = 400;

function sanitizeTavilyQuery(value) {

    return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, TAVILY_MAX_QUERY_LENGTH);
}

// Builds a short, search-engine-style query from a category's topic
// list, instead of ever sending the full instructional prompt to
// Tavily. include_domains (passed separately in callTavily) already
// restricts *where* Tavily looks, so this only needs to describe
// *what* to look for.
function buildTavilySearchQuery(category, topics) {

    const topicPart =
        Array.isArray(topics) && topics.length
            ? topics.slice(0, 8).join(", ")
            : "";

    return sanitizeTavilyQuery(
        `Kenya ${category || ""} ${topicPart}`
    );
}

async function callTavily(
    prompt,
    searchQuery,
    domains
) {

    const body = {

        api_key: TAVILY_API_KEY,

        query:
            sanitizeTavilyQuery(searchQuery) ||
            // Safety net only - a caller that forgot to build a
            // proper short query still gets a request that won't
            // 422, rather than a crash.
            sanitizeTavilyQuery(prompt),

        search_depth: "advanced",

        include_answer: true,

        max_results: 10
    };

    if (
        Array.isArray(domains) &&
        domains.length
    ) {

        body.include_domains = domains;
    }

    const response =
        await fetch(
            TAVILY_SEARCH_URL,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${TAVILY_API_KEY}`
                },

                body: JSON.stringify(body)
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            extractApiErrorMessage(
                data,
                `Tavily request failed (${response.status})`
            )
        );
    }

    const results =
        Array.isArray(data?.results)
            ? data.results
            : [];

    const answer =
        typeof data?.answer === "string"
            ? data.answer.trim()
            : "";

    // If Tavily's synthesized answer already looks like it contains a
    // JSON object, trust it and skip the extra compose call.
    if (
        answer &&
        answer.includes("{") &&
        answer.includes("}")
    ) {

        return answer;
    }

    if (!results.length && !answer) {

        return JSON.stringify({ items: [] });
    }

    const resultsBlock =
        results
            .map(
                (result, index) =>
                    `${index + 1}. ${result.title || ""}\n` +
                    `URL: ${result.url || ""}\n` +
                    `${result.content || ""}`
            )
            .join("\n\n");

    // No usable JSON from Tavily directly — hand its raw findings to
    // Cerebras (if configured) to compose the required JSON strictly
    // from this material. Without Cerebras, fall back to whatever
    // Tavily gave us (answer, or the raw results block), same as
    // before this fallback existed. The FULL instructional `prompt`
    // (rules, JSON schema, existing articles) belongs here, in the
    // compose step sent to an actual LLM (Cerebras) - never in the
    // Tavily `query` field itself.
    if (!cerebrasClient) {

        return answer || resultsBlock;
    }

    const composePrompt =
        `${prompt}\n\n` +
        `===== LIVE TAVILY SEARCH RESULTS (use ONLY these, do not invent anything beyond them) =====\n` +
        `${answer ? `Synthesized answer: ${answer}\n\n` : ""}` +
        `${resultsBlock}\n` +
        `===== END SEARCH RESULTS =====`;

    // This is a SEPARATE call to a SEPARATE provider (Cerebras, not
    // Tavily). Without this try/catch, a Cerebras failure here bubbles
    // up looking exactly like a Tavily failure to whatever logs
    // error.message under "(tavily)" - which is exactly what made a
    // 404 from Cerebras look like a Tavily problem. Re-labelling it
    // here means the console output points at the actual broken
    // provider instead of the one that happened to call it.
    try {

        return await textWithCerebras(
            composePrompt
        );

    } catch (error) {

        throw new Error(
            `Tavily search succeeded, but the Cerebras JSON-compose ` +
            `step failed: ${error.message}`
        );
    }
}

async function searchWithTavily(
    prompt,
    domains,
    topics,
    category
) {

    const searchQuery =
        buildTavilySearchQuery(
            category,
            topics
        );

    return callTavily(
        prompt,
        searchQuery,
        domains
    );
}

async function textWithTavily(
    prompt,
    searchHint
) {

    // No "topics" list makes sense here - this call is for writing/
    // updating a single already-verified article, not discovering
    // new ones. searchHint (the item's source URL or title, supplied
    // by the caller) grounds Tavily's search on that specific story
    // instead of re-running a category-wide search.
    const searchQuery =
        sanitizeTavilyQuery(searchHint) ||
        "Kenya university student information";

    return callTavily(
        prompt,
        searchQuery
    );
}


// ========================================
// PROVIDER DISPATCH
// ========================================

async function runProviderSearch(
    provider,
    prompt,
    domains,
    topics,
    category
) {

    switch (provider) {

        case "openai":
            return searchWithOpenAI(prompt, domains);

        case "groq":
            return searchWithGroq(prompt);

        case "gemini":
            return searchWithGemini(prompt);

        case "perplexity":
            return searchWithPerplexity(prompt);

        case "cohere":
            return searchWithCohere(prompt);

        case "exa":
            return searchWithExa(prompt);

        case "cerebras":
            return searchWithCerebras(prompt);

        case "tavily":
            return searchWithTavily(prompt, domains, topics, category);

        default:
            throw new Error(
                `Unknown provider: ${provider}`
            );
    }
}


async function runProviderText(
    provider,
    prompt,
    searchHint
) {

    switch (provider) {

        case "openai":
            return textWithOpenAI(prompt);

        case "groq":
            return textWithGroq(prompt);

        case "gemini":
            return textWithGemini(prompt);

        case "perplexity":
            return textWithPerplexity(prompt);

        case "cohere":
            return textWithCohere(prompt);

        case "exa":
            return textWithExa(prompt);

        case "cerebras":
            return textWithCerebras(prompt);

        case "tavily":
            return textWithTavily(prompt, searchHint);

        default:
            throw new Error(
                `Unknown provider: ${provider}`
            );
    }
}


// ========================================
// DISCOVER CURRENT INFORMATION
// ========================================

async function discoverInformation(
    config,
    existingArticles
) {

    console.log("");
    console.log(
        "========================================"
    );

    console.log(
        `SEARCHING: ${config.name}`
    );

    console.log(
        "Official domains:",
        config.domains.join(", ")
    );

    // Exa never went through the AI-JSON prompt below - see
    // discoverWithExaSearch() and the comment above it for why.
    if (config.provider === "exa") {

        return discoverWithExaSearch(
            config,
            existingArticles
        );
    }

    const existing =
        existingArticles
            .filter(
                article =>
                    article.category ===
                    config.category
            )
            .slice(0, 100)
            .map(
                article => ({
                    title:
                        article.title,

                    url:
                        article.sourceUrl,

                    date:
                        article.date,

                    hash:
                        article.sourceHash
                })
            );


    const prompt = `You are the automatic information discovery engine for Kenya Campus Hub.

Today's date is ${new Date().toISOString().split("T")[0]}.

Your task is to search the internet for CURRENT information from the official websites/domains provided.

CATEGORY:
${config.category}

OFFICIAL DOMAINS:
${config.domains.join(", ")}

TOPICS TO MONITOR:
${config.topics.join("\n")}

CATEGORY-SPECIFIC SCHOLARSHIP SEARCH:

If the category is Scholarships, actively search for CURRENT scholarship opportunities rather than general education news.

Look specifically for:

- scholarships that are currently open
- newly announced scholarships
- application opening dates
- application closing dates
- undergraduate scholarships
- Masters scholarships
- PhD scholarships
- fully funded scholarships
- partially funded scholarships
- fellowships
- Kenyan student eligibility
- nationality requirements
- university requirements
- academic requirements
- age requirements where officially stated
- tuition funding
- stipend
- accommodation
- travel funding
- living allowance
- application instructions
- official application pages
- scholarship results
- deadline extensions
- deadline changes
- cancellations
- 2026 opportunities
- 2027 opportunities

Do NOT return a generic education article just because it mentions funding.

A Scholarships item must actually describe:

1. A scholarship
2. A fellowship
3. A student funding opportunity
4. An application opportunity
5. A scholarship announcement
6. A scholarship deadline
7. A scholarship eligibility requirement
8. A scholarship result
9. A scholarship extension or change

Search individual scholarship announcement/application pages, not only category pages or homepages.

CATEGORY-SPECIFIC UNIVERSITY ALERTS SEARCH:

If the category is University Alerts, actively search for CURRENT disruptions or changes to normal university learning, rather than routine news.

Look specifically for:

- ongoing or newly announced lecturer/staff strikes (e.g. UASU industrial action)
- student unrest, demonstrations, or protests
- university closures or suspension of learning
- semester or exam postponements
- changes to the academic calendar (reopening/closing dates)
- official senate or vice-chancellor circulars affecting learning
- campus insecurity or safety alerts
- sudden fee structure changes
- weather-related or health-related closures
- Ministry of Education or CUE directives affecting universities
- university mergers or accreditation changes

For this category only, reputable Kenyan news sources may be used in addition to official domains, because strikes and unrest are often confirmed by press coverage before any official university statement appears. Always prefer the official university/government circular when one exists, and clearly mark information sourced from news coverage as unconfirmed by the institution if no official circular is cited.

Do NOT report a strike, closure or unrest as happening unless it is reported as current or ongoing by a credible source. Do NOT invent which institution is affected — if a report is nationwide (e.g. a national UASU strike), say so; if it affects a specific university, name only that university.

IMPORTANT:

1. Search the official domains only.
2. Find information that is genuinely useful to Kenyan students.
3. Prioritize NEW or recently UPDATED information.
4. Search individual news/articles/announcements/pages, NOT only the homepage.
5. Look for announcements, deadlines, applications, opportunities, requirements, results, changes and instructions.
6. Do not invent information.
7. Do not use unofficial blogs when an official source exists.
8. If the official page contains a date, deadline, amount, requirement or application procedure, preserve it accurately.
9. Find as many relevant current items as reasonably possible.
10. Existing articles are supplied below. Do NOT return an item merely because it exists. Return it only if it is genuinely new or its official information has changed.
11. Do not classify a HELB loan as a Scholarship unless the official source clearly identifies it as a scholarship.
12. Do not classify ordinary university news as a Scholarship.
13. Do not create scholarship information from memory.
14. If you cannot verify the scholarship from an official source, do not return it.
15. For University Alerts, do not invent or assume a strike/closure/unrest is happening — only report it if a credible source describes it as current.
16. For University Alerts, state clearly whether the disruption is nationwide or limited to specific named institution(s).
17. For University Alerts, do not invent reopening dates, deadlines, or fee amounts.
18. Whenever the official source states (or clearly implies) a date after which this information is no longer relevant — an application deadline, a job closing date, an exam/placement date, a reopening date that ends a closure — extract it as "expiryDate". If no such date exists or is unclear, set "expiryDate" to null. Never invent an expiryDate.

EXISTING ARTICLES:
${JSON.stringify(existing, null, 2)}

Return ONLY valid JSON in this exact structure:

{
  "items": [
    {
      "title": "Official announcement title",
      "sourceUrl": "https://official-source-url",
      "publishedDate": "YYYY-MM-DD or null",
      "updatedDate": "YYYY-MM-DD or null",
      "expiryDate": "YYYY-MM-DD or null — the date this information stops being relevant/current, if officially stated",
      "topic": "short topic",
      "importance": "high",
      "reason": "why this is new or changed",
      "scope": "Nationwide, or the specific institution name (University Alerts only, otherwise null)",
      "facts": [
        "verified fact 1",
        "verified fact 2",
        "verified fact 3"
      ]
    }
  ]
}

Only include items from the official domains (for University Alerts, reputable Kenyan news domains are also allowed as described above).

For Scholarships, each returned item MUST be an actual scholarship/fellowship/funding opportunity or an official scholarship announcement.

For University Alerts, each returned item MUST describe an actual strike, closure, unrest, postponement, calendar change, or other genuine disruption/change to university learning — not routine campus news.

If nothing new or changed exists, return:

{
  "items": []
}
`;


    try {

        const rawText =
            await runProviderSearch(
                config.provider,
                prompt,
                config.domains,
                config.topics,
                config.category
            );

        const result =
            parseAIJson(
                rawText
            );

        if (
            !result.items ||
            !Array.isArray(
                result.items
            )
        ) {

            return [];
        }

        const filtered =
            filterItemsByDomain(
                result.items,
                config.domains
            );

        console.log(
            `Found ${filtered.length} candidate item(s) (${config.provider}).`
        );

        return filtered;

    } catch (error) {

        console.error(
            `Search failed for ${config.name} (${config.provider}):`,
            error.message
        );

        return [];
    }
}


// ========================================
// GENERATE FULL ARTICLE
// ========================================

async function generateArticle(
    item,
    config
) {

    console.log("");
    console.log(
        "Generating detailed article:"
    );

    console.log(
        item.title
    );

    // Exa writes plain prose, not JSON - see writeExaArticleProse()
    // and the comment above it.
    if (config.provider === "exa") {

        try {

            const article =
                await writeExaArticleProse(
                    item,
                    config,
                    null
                );

            if (
                !article ||
                !article.title ||
                !article.content
            ) {

                throw new Error(
                    "Exa generated an incomplete article"
                );
            }

            return article;

        } catch (error) {

            console.error(
                "Article generation failed (exa):",
                error.message
            );

            return null;
        }
    }


    const prompt = `You are the senior student-information writer for Kenya Campus Hub.

Write a detailed, accurate and useful article for Kenyan university, college and TVET students.

CATEGORY:
${config.category}

OFFICIAL TITLE:
${item.title}

OFFICIAL SOURCE:
${item.sourceUrl}

TOPIC:
${item.topic}

SCOPE (University Alerts only):
${item.scope || "N/A"}

EXPIRY DATE (when this stops being relevant, if known):
${item.expiryDate || "N/A"}

VERIFIED FACTS:
${JSON.stringify(
    item.facts,
    null,
    2
)}

WHY THIS IS NEW OR CHANGED:
${item.reason}

RULES:

- Use ONLY facts supported by the official source and verified information.
- Do NOT invent dates.
- Do NOT invent amounts.
- Do NOT invent eligibility requirements.
- Do NOT invent application links.
- Do NOT invent contact information.
- Do NOT claim something is open unless the official information supports it.
- Clearly explain deadlines.
- Clearly explain who is affected.
- Explain what students should do.
- Write a genuinely DETAILED, thorough article — aim for at least 500-700 words of substantive content, not a short summary. Expand each section fully: give context, explain implications, spell out step-by-step instructions where relevant, and anticipate follow-up questions a student would have.
- Use simple, clear language, but do not sacrifice detail for brevity — explain thoroughly rather than briefly.
- Keep the article relevant to Kenyan students.
- Mention the official source at the end.
- If information is unclear, say that students should verify with the official source, but still explain everything that IS known in full detail.

SPECIAL SCHOLARSHIP RULE:

If CATEGORY is Scholarships:

- Make the article specifically about the scholarship/fellowship opportunity.
- Clearly state the scholarship name.
- Clearly state who can apply.
- Clearly state the study level.
- Clearly state funding provided if officially stated.
- Clearly state the deadline if officially stated.
- Clearly state how to apply.
- Include the official application/source link.
- Do not turn general education news into a scholarship article.
- Do not invent missing scholarship details.

SPECIAL UNIVERSITY ALERTS RULE:

If CATEGORY is University Alerts:

- Clearly state what is happening (strike, closure, unrest, postponement, calendar change, etc.).
- Clearly state whether it is nationwide or limited to a specific institution, using the SCOPE field.
- Clearly state the current status (ongoing, resolved, pending) if known.
- Clearly state the expected duration or reopening date only if officially confirmed.
- If the information came from news coverage rather than an official circular, say so, and advise students to confirm with their institution.
- Do not speculate about causes or take sides; report only verified facts.
- Explain practical next steps for affected students (e.g. checking their university's official communication channels).

Write the article using these sections:

1. What This Announcement Is About
2. Who Is Affected
3. The Important Information
4. Eligibility or Requirements
5. Important Dates and Deadlines
6. How Students Can Apply or Access the Service
7. What Students Should Do Now
8. Important Things to Remember
9. Official Source

For sections where information is unavailable, do not invent information. Explain only what is supported.

Return ONLY valid JSON:

{
  "title": "clear student-friendly title",
  "summary": "3-5 sentence summary",
  "content": "FULL DETAILED ARTICLE WITH CLEAR SECTION HEADINGS (aim for 500-700+ words)",
  "source": "official organization name",
  "sourceUrl": "official source URL",
  "publishedDate": "YYYY-MM-DD or null",
  "expiresAt": "YYYY-MM-DD or null — copy from the EXPIRY DATE above if given, otherwise null"
}
`;


    try {

        const rawText =
            await runProviderText(
                config.provider,
                prompt,
                item.sourceUrl || item.title
            );


        const article =
            parseAIJson(
                rawText
            );


        if (
            !article.title ||
            !article.content
        ) {

            throw new Error(
                "AI generated incomplete article"
            );
        }


        return article;

    } catch (error) {

        console.error(
            `Article generation failed (${config.provider}):`,
            error.message
        );

        return null;
    }
}


// ========================================
// UPDATE EXISTING ARTICLE
// ========================================

async function updateExistingArticle(
    existing,
    item,
    config
) {

    console.log("");
    console.log(
        "Updating changed article:"
    );

    console.log(
        existing.title
    );

    // Exa writes plain prose, not JSON - see writeExaArticleProse()
    // and the comment above it.
    if (config.provider === "exa") {

        try {

            const updated =
                await writeExaArticleProse(
                    item,
                    config,
                    existing
                );

            if (
                !updated ||
                !updated.title ||
                !updated.content
            ) {

                return null;
            }

            return updated;

        } catch (error) {

            console.error(
                "Update generation failed (exa):",
                error.message
            );

            return null;
        }
    }


    const prompt = `You are updating an existing student information article for Kenya Campus Hub.

CATEGORY:
${config.category}

OLD ARTICLE:
${JSON.stringify(
    existing,
    null,
    2
)}

NEW VERIFIED INFORMATION:
${JSON.stringify(
    item,
    null,
    2
)}

SOURCE:
${item.sourceUrl}

Instructions:

- Keep accurate information from the old article.
- Replace information that has changed.
- Add newly announced information.
- Remove outdated information when appropriate.
- Do not invent anything.
- Preserve official dates and requirements exactly.
- Write a genuinely DETAILED, thorough article — aim for at least 500-700 words of substantive content. Expand each section fully rather than trimming it down.
- Make it clear what has changed where useful.
- If the new information includes an expiry/deadline/reopening date, carry it into "expiresAt"; otherwise keep the old article's expiresAt if it is still valid, or null.

If CATEGORY is Scholarships:

- Keep the article specifically about the scholarship/fellowship opportunity.
- Update deadline changes.
- Update eligibility changes.
- Update funding changes.
- Update application instructions.
- Do not add information that is not verified.

Return ONLY valid JSON:

{
  "title": "updated title",
  "summary": "updated 3-5 sentence summary",
  "content": "FULL UPDATED, DETAILED ARTICLE (aim for 500-700+ words)",
  "source": "official organization",
  "sourceUrl": "official source URL",
  "publishedDate": "YYYY-MM-DD or null",
  "expiresAt": "YYYY-MM-DD or null"
}
`;


    try {

        const rawText =
            await runProviderText(
                config.provider,
                prompt,
                item.sourceUrl || existing.sourceUrl || existing.title
            );


        const updated =
            parseAIJson(
                rawText
            );


        if (
            !updated.title ||
            !updated.content
        ) {

            return null;
        }


        return updated;

    } catch (error) {

        console.error(
            `Update generation failed (${config.provider}):`,
            error.message
        );

        return null;
    }
}


// ========================================
// CHECK SCHOLARSHIP ITEM
// ========================================

function isValidScholarshipItem(item) {

    if (!item) {
        return false;
    }

    if (!item.title) {
        return false;
    }

    if (!item.sourceUrl) {
        return false;
    }

    const text =
        (
            `${item.title} ` +
            `${item.topic || ""} ` +
            `${item.reason || ""} ` +
            `${(item.facts || []).join(" ")}`
        )
            .toLowerCase();

    const scholarshipWords = [
        "scholarship",
        "scholarships",
        "fellowship",
        "fellowships",
        "funded",
        "funding",
        "student grant",
        "study grant",
        "bursary"
    ];

    return scholarshipWords.some(
        word =>
            text.includes(word)
    );
}


// ========================================
// CHECK UNIVERSITY ALERT ITEM
// ========================================

function isValidUniversityAlertItem(item) {

    if (!item) {
        return false;
    }

    if (!item.title) {
        return false;
    }

    if (!item.sourceUrl) {
        return false;
    }

    const text =
        (
            `${item.title} ` +
            `${item.topic || ""} ` +
            `${item.reason || ""} ` +
            `${(item.facts || []).join(" ")}`
        )
            .toLowerCase();

    const alertWords = [
        "strike",
        "unrest",
        "protest",
        "demonstration",
        "closure",
        "closed",
        "suspend",
        "suspension",
        "postpone",
        "reopening",
        "reopen",
        "closing date",
        "calendar",
        "circular",
        "senate",
        "vice-chancellor",
        "vice chancellor",
        "insecurity",
        "boycott",
        "disruption"
    ];

    return alertWords.some(
        word =>
            text.includes(word)
    );
}


// ========================================
// PROCESS SOURCE
// ========================================

async function processSource(
    config,
    articles
) {

    if (!availableProviders[config.provider]) {

        console.log(
            `Skipping ${config.name}: no API key configured for provider "${config.provider}".`
        );

        return;
    }


    const candidates =
        await discoverInformation(
            config,
            articles
        );


    if (!candidates.length) {

        console.log(
            `No new information found for ${config.name}.`
        );

        return;
    }


    for (
        const item of candidates
    ) {

        // Pace requests between items so generating/updating several
        // articles in a row doesn't burst past a provider's per-minute
        // request limit.
        await sleep(
            DELAY_BETWEEN_ITEMS_MS
        );

        if (
            !item.title ||
            !item.sourceUrl
        ) {
            continue;
        }


        // Extra protection for Scholarships
        if (
            config.category === "Scholarships" &&
            !isValidScholarshipItem(item)
        ) {

            console.log(
                `Skipped non-scholarship item: ${item.title}`
            );

            continue;
        }


        // Extra protection for University Alerts
        if (
            config.category === "University Alerts" &&
            !isValidUniversityAlertItem(item)
        ) {

            console.log(
                `Skipped non-alert item: ${item.title}`
            );

            continue;
        }


        const sourceHash =
            crypto
                .createHash("sha256")
                .update(
                    JSON.stringify(
                        item.facts || []
                    )
                )
                .digest("hex");


        // Find by official source URL
        const existingIndex =
            articles.findIndex(
                article =>
                    article.sourceUrl ===
                    item.sourceUrl
            );


        // ====================================
        // EXISTING ARTICLE
        // ====================================

        if (
            existingIndex !== -1
        ) {

            const existing =
                articles[
                    existingIndex
                ];


            // Nothing changed
            if (
                existing.sourceHash ===
                sourceHash
            ) {

                console.log(
                    `No change: ${item.title}`
                );

                continue;
            }


            const updated =
                await updateExistingArticle(
                    existing,
                    {
                        ...item,
                        sourceHash
                    },
                    config
                );


            if (!updated) {
                continue;
            }


            articles[
                existingIndex
            ] = {

                ...existing,

                ...updated,

                category:
                    config.category,

                sourceHash,

                updated:
                    new Date()
                        .toISOString(),

                lastChecked:
                    new Date()
                        .toISOString(),

                type:
                    "ai-generated"
            };


            console.log(
                `UPDATED: ${updated.title}`
            );

            continue;
        }


        // ====================================
        // NEW ARTICLE
        // ====================================

        const article =
            await generateArticle(
                {
                    ...item,
                    sourceHash
                },
                config
            );


        if (!article) {
            continue;
        }


        const now =
            new Date()
                .toISOString();


        const id =
            makeId(
                article.title,
                article.sourceUrl ||
                item.sourceUrl
            );


        // Extra title duplicate check
        const duplicateTitle =
            articles.some(
                existing =>
                    existing.title
                        ?.toLowerCase()
                        .trim() ===
                    article.title
                        ?.toLowerCase()
                        .trim()
            );


        if (
            duplicateTitle
        ) {

            console.log(
                `Skipped duplicate title: ${article.title}`
            );

            continue;
        }


        const newArticle = {

            id,

            title:
                article.title,

            summary:
                article.summary || "",

            content:
                article.content,

            category:
                config.category,

            source:
                article.source ||
                config.name,

            sourceUrl:
                article.sourceUrl ||
                item.sourceUrl,

            date:
                article.publishedDate ||
                item.publishedDate ||
                now,

            expiresAt:
                article.expiresAt ||
                item.expiryDate ||
                null,

            updated:
                null,

            sourceHash,

            lastChecked:
                now,

            type:
                "ai-generated"
        };


        articles.unshift(
            newArticle
        );


        console.log(
            `NEW ARTICLE: ${newArticle.title}`
        );
    }
}


// ========================================
// MAIN
// ========================================

async function main() {

    console.log("");
    console.log(
        "========================================"
    );

    console.log(
        "       KENYA CAMPUS HUB"
    );

    console.log(
        "       AI INFORMATION ENGINE"
    );

    console.log(
        "========================================"
    );

    console.log(
        new Date().toLocaleString()
    );

    console.log(
        `Monitoring ${sourceConfigs.length} information categories`
    );

    console.log(
        "Providers configured:"
    );

    console.log(
        `  OpenAI:     ${availableProviders.openai ? "yes" : "no (OPENAI_API_KEY missing)"}`
    );

    console.log(
        `  Groq:       ${availableProviders.groq ? "yes" : "no (GROQ_API_KEY missing)"}`
    );

    console.log(
        `  Gemini:     ${availableProviders.gemini ? "yes" : "no (GEMINI_API_KEY missing)"}`
    );

    console.log(
        `  Perplexity: ${availableProviders.perplexity ? "yes" : "no (PERPLEXITY_API_KEY missing)"}`
    );

    console.log(
        `  Cohere:     ${availableProviders.cohere ? "yes" : "no (COHERE_API_KEY missing)"}`
    );

    console.log(
        `  Exa:        ${availableProviders.exa ? "yes" : "no (EXA_API_KEY missing)"}`
    );

    console.log(
        `  Cerebras:   ${availableProviders.cerebras ? "yes" : "no (CEREBRAS_API_KEY missing)"}`
    );

    console.log(
        `  Tavily:     ${availableProviders.tavily ? "yes" : "no (TAVILY_API_KEY missing)"}${availableProviders.tavily && !availableProviders.cerebras ? " (CEREBRAS_API_KEY also recommended, as a JSON-composing fallback)" : ""}`
    );

    console.log(
        "========================================"
    );


    if (
        !Object.values(availableProviders).some(Boolean)
    ) {

        console.error(
            "ERROR: No AI provider API keys found in .env. " +
            "Set at least one of OPENAI_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, COHERE_API_KEY, EXA_API_KEY, CEREBRAS_API_KEY."
        );

        process.exit(1);
    }


    let articles =
        loadArticles();


    console.log(
        `Existing articles: ${articles.length}`
    );


    // Optional CLI filter: `node ai-updater.js "University Alerts"`
    // runs only that one category instead of the full sweep - handy
    // for debugging a single provider without waiting on (or
    // burning quota from) every other category first.
    const categoryFilter =
        process.argv[2] ||
        null;

    const configsToRun =
        categoryFilter
            ? sourceConfigs.filter(
                  config =>
                      config.category.toLowerCase() ===
                      categoryFilter.toLowerCase()
              )
            : sourceConfigs;

    if (
        categoryFilter &&
        !configsToRun.length
    ) {

        console.error(
            `No category matches "${categoryFilter}". ` +
            `Available: ${sourceConfigs.map(c => c.category).join(", ")}`
        );

        process.exit(1);
    }

    if (categoryFilter) {

        console.log(
            `Running ONLY: ${configsToRun.map(c => c.category).join(", ")}`
        );
    }


    for (
        const config of configsToRun
    ) {

        try {

            await processSource(
                config,
                articles
            );

        } catch (error) {

            console.error(
                `Category error (${config.name}):`,
                error.message
            );
        }


        // Pace requests so we never burst past a provider's
        // requests-per-minute limit.
        await sleep(
            DELAY_BETWEEN_SOURCES_MS
        );
    }


    const beforeExpiry =
        articles.length;

    articles =
        pruneExpiredArticles(
            articles
        );

    const expiredCount =
        beforeExpiry - articles.length;


    // newest first
    articles.sort(
        (a, b) =>
            new Date(
                b.date || 0
            ) -
            new Date(
                a.date || 0
            )
    );


    saveArticles(
        articles
    );


    console.log("");

    console.log(
        "========================================"
    );

    console.log(
        `TOTAL ARTICLES: ${articles.length}`
    );

    console.log(
        `EXPIRED & REMOVED: ${expiredCount}`
    );

    console.log(
        "DATABASE UPDATED"
    );

    console.log(
        "========================================"
    );
}


main();