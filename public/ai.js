/* =========================================================
   KENYAN CAMPUS AI
   FULL AI.JS
   Version: 2026
   ========================================================= */

"use strict";

/* =========================================================
   1. GLOBAL STATE
   ========================================================= */

let campusAIThinking = false;
let campusAIHistory = [];
let campusAIUploadedDocuments = [];
let campusAIActiveDocuments = [];
let campusAIAbortController = null;

let campusAIChats = [];
let campusAICurrentChatId = null;

let campusAIVoiceRecognition = null;
let campusAIVoiceListening = false;

let campusAITalkRecognition = null;
let campusAITalkListening = false;
let campusAITalkShouldListen = false;
let campusAITalkProcessing = false;
let campusAITalkFinalTranscript = "";
let campusAITalkLastSubmitted = "";
let campusAITalkAbortController = null;
let campusAITalkSpeechQueueCount = 0;

/*
   Talk mode listens continuously and auto-sends
   once the user has been quiet for a short pause,
   instead of requiring a manual send.
*/
let campusAITalkSilenceTimer = null;
const CAMPUS_AI_TALK_SILENCE_MS = 1400;

let campusAISpeechToken = 0;
let campusAISpeaking = false;

let campusAISummaryInFlight = new Set();

const CAMPUS_AI_STORAGE_KEY = "kenyaCampusHubAIChats";
const CAMPUS_AI_ACCOUNTS_KEY = "kenyaCampusHubAIAccounts";
const CAMPUS_AI_CURRENT_ACCOUNT_KEY = "kenyaCampusHubAICurrentAccount";
const CAMPUS_AI_VOICE_SETTINGS_KEY = "kenyaCampusHubAIVoiceSettings";

const CAMPUS_AI_IDENTITY = {
    name: "Kenyan Campus AI",
    email: "campusai@kenyacampushub.com"
};

const CAMPUS_AI_DEFAULT_VOICE_SETTINGS = {
    voiceURI: "",
    rate: 1,
    pitch: 1,
    volume: 1,
    autoRead: false,
    /*
       Per-voice pitch/rate memory. Without this, adjusting
       the pitch for one voice (say, to make a male voice
       deeper) silently carried that same pitch over to
       every OTHER voice too - including women's voices,
       which is exactly why a "woman's voice" could come out
       sounding wrong. Each voiceURI now remembers its own
       tone; switching voices restores that voice's own
       settings (or neutral defaults for a voice never
       tuned before) instead of reusing the last voice's.
    */
    voiceOverrides: {}
};

let campusAIVoiceSettings = {
    ...CAMPUS_AI_DEFAULT_VOICE_SETTINGS
};


/* =========================================================
   2. BASIC HELPERS
   ========================================================= */

function campusAI$(id) {
    return document.getElementById(id);
}


/* =========================================================
   1B. DYNAMIC STYLES
   Injected once so the new/moved UI pieces
   (account badge, flat history rows, centered
   talk mic) render correctly without needing
   a separate stylesheet file.
   ========================================================= */

function campusAIInjectDynamicStyles() {

    if (campusAI$("campusAiDynamicStyles")) {
        return;
    }

    const style =
        document.createElement("style");

    style.id =
        "campusAiDynamicStyles";

    style.textContent = `
        .campus-ai-table-wrap {
            overflow-x: auto;
            margin: 10px 0;
            -webkit-overflow-scrolling: touch;
        }

        .campus-ai-table {
            border-collapse: collapse;
            width: 100%;
            min-width: 320px;
            font-size: 0.94em;
        }

        .campus-ai-table th,
        .campus-ai-table td {
            border: 1px solid rgba(120,120,120,0.3);
            padding: 6px 10px;
            text-align: left;
            vertical-align: top;
        }

        .campus-ai-table th {
            background: rgba(120,120,120,0.12);
            font-weight: 600;
        }

        .campus-ai-table tbody tr:nth-child(even) {
            background: rgba(120,120,120,0.05);
        }

        #campusAiSidebar {
            display: flex;
            flex-direction: column;
        }

        .campus-ai-history-item.campus-ai-history-item-flat {
            background: transparent !important;
            border: none !important;
            border-bottom: 1px solid rgba(120,120,120,0.14) !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            text-align: left;
            padding: 12px 14px !important;
        }

        .campus-ai-history-item.campus-ai-history-item-flat:hover {
            background: rgba(120,120,120,0.08) !important;
        }

        .campus-ai-history-item.campus-ai-history-item-flat.active {
            background: rgba(70,120,255,0.12) !important;
        }

        .campus-ai-history-summary {
            font-size: 0.85rem;
            opacity: 0.85;
            display: block;
        }

        .campus-ai-sidebar-footer {
            position: sticky;
            bottom: 0;
            margin-top: auto;
            padding: 10px 12px;
            border-top: 1px solid rgba(120,120,120,0.15);
            background: inherit;
            z-index: 5;
        }

        .campus-ai-account-badge {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 600;
            font-size: 0.8rem;
            letter-spacing: 0.5px;
            background: linear-gradient(135deg,#2f6df6,#7c4dff);
            color: #fff;
            border: none;
            cursor: pointer;
        }

        .campus-ai-more-menu.campus-ai-more-menu-docked {
            position: absolute;
            bottom: 56px;
            left: 8px;
            top: auto;
        }

        .campus-ai-talk-header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 14px 16px;
        }

        .campus-ai-talk-header .campus-ai-talk-name {
            font-weight: 600;
            opacity: 0.85;
        }

        .campus-ai-talk-center {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 18px;
            flex: 1;
            min-height: 60vh;
            text-align: center;
        }

        .campus-ai-talk-mic {
            width: 108px;
            height: 108px;
            border-radius: 50%;
            font-size: 2.4rem;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
            cursor: pointer;
            background: linear-gradient(135deg,#2f6df6,#7c4dff);
            color: #fff;
            box-shadow: 0 8px 30px rgba(60,90,255,0.35);
        }

        .campus-ai-talk-mic.listening {
            animation: campusAiTalkPulse 1.4s infinite;
        }

        @keyframes campusAiTalkPulse {
            0% { box-shadow: 0 0 0 0 rgba(60,90,255,0.45); }
            70% { box-shadow: 0 0 0 22px rgba(60,90,255,0); }
            100% { box-shadow: 0 0 0 0 rgba(60,90,255,0); }
        }

        .campus-ai-talk-status {
            font-size: 0.95rem;
            opacity: 0.8;
        }

        .campus-ai-link-button {
            background: none;
            border: none;
            color: #2f6df6;
            font-size: 0.85rem;
            cursor: pointer;
            padding: 6px 0;
            text-decoration: underline;
            display: inline-block;
        }

        .campus-ai-account-note-success {
            color: #1a9c53 !important;
        }
    `;

    document.head.appendChild(style);
}

function campusAIUid(prefix = "ai") {
    return (
        prefix +
        "_" +
        Date.now().toString(36) +
        "_" +
        Math.random().toString(36).slice(2, 9)
    );
}

function campusAIEscapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function campusAIEscapeAttribute(value) {
    return campusAIEscapeHTML(value);
}

function campusAIIsTalkOpen() {
    const page = campusAI$("campusAiTalkPage");
    return !!page && page.classList.contains("open");
}

function campusAIGetHomeURL() {
    return "index.html";
}


/* =========================================================
   3. INITIALIZATION
   ========================================================= */

function initializeCampusAI() {

    campusAIInjectDynamicStyles();

    campusAILoadChats();
    campusAILoadVoiceSettings();

    campusAISetSendIcon();

    campusAIEnsureTalkPage();
    campusAIEnsureMoreMenu();
    campusAIEnsureVoiceTalkButton();

    campusAIRenderWelcome();
    campusAIRenderHistory();

    const input = campusAI$("campusAiInput");

    if (input) {
        input.addEventListener("input", function () {
            campusAIResizeInput();
            campusAIUpdateSendState();
        });

        input.addEventListener("keydown", handleCampusAIKey);
    }

    if ("speechSynthesis" in window) {
        speechSynthesis.onvoiceschanged = function () {
            populateCampusAIVoices();
        };
    }

    campusAIUpdateSendState();
}


/* =========================================================
   4. OPEN / CLOSE AI PAGE
   ========================================================= */

function openCampusAI() {

    const page = campusAI$("campusAiPage");

    if (!page) {
        window.location.href = "ai.html";
        return;
    }

    page.classList.add("active", "open");

    document.body.classList.add("campus-ai-open");
    document.body.style.overflow = "hidden";

    campusAIRenderWelcome();
    campusAIRenderHistory();
    campusAIUpdateSendState();

    const input = campusAI$("campusAiInput");

    if (input) {
        setTimeout(() => input.focus(), 100);
    }
}


function closeCampusAI() {

    stopCampusAI();

    closeCampusAITalkPage();
    closeCampusAISettings();
    closeCampusAIAccount();
    closeCampusAIMoreMenu();

    /*
       Dedicated ai.html:
       Always return to index.html.
    */

    if (
        location.pathname.endsWith("/ai.html") ||
        location.pathname.endsWith("ai.html")
    ) {
        window.location.href = campusAIGetHomeURL();
        return;
    }

    /*
       If AI is embedded inside index.html,
       still return to index.html.
    */

    window.location.href = campusAIGetHomeURL();
}


/* =========================================================
   5. SIDEBAR
   ========================================================= */

function toggleCampusAISidebar() {

    const sidebar = campusAI$("campusAiSidebar");
    const overlay = campusAI$("campusAiSidebarOverlay");

    if (!sidebar) return;

    sidebar.classList.toggle("open");

    if (overlay) {
        overlay.classList.toggle(
            "open",
            sidebar.classList.contains("open")
        );
        overlay.classList.toggle(
            "active",
            sidebar.classList.contains("open")
        );
    }
}


function closeCampusAISidebar() {

    const sidebar = campusAI$("campusAiSidebar");
    const overlay = campusAI$("campusAiSidebarOverlay");

    if (sidebar) {
        sidebar.classList.remove("open");
    }

    if (overlay) {
        overlay.classList.remove("open", "active");
    }
}


/* =========================================================
   6. LOCAL STORAGE - ACCOUNTS
   ========================================================= */

function campusAILoadAccounts() {

    try {
        return JSON.parse(
            localStorage.getItem(CAMPUS_AI_ACCOUNTS_KEY) || "[]"
        );
    } catch {
        return [];
    }
}


function campusAISaveAccounts(accounts) {

    localStorage.setItem(
        CAMPUS_AI_ACCOUNTS_KEY,
        JSON.stringify(accounts)
    );
}


function campusAIGetCurrentAccountId() {

    return (
        localStorage.getItem(
            CAMPUS_AI_CURRENT_ACCOUNT_KEY
        ) || "guest"
    );
}


function campusAIGetCurrentAccount() {

    const id = campusAIGetCurrentAccountId();

    if (id === "guest") {
        return {
            id: "guest",
            name: "Guest",
            email: ""
        };
    }

    const accounts = campusAILoadAccounts();

    return (
        accounts.find(account => account.id === id) || {
            id: "guest",
            name: "Guest",
            email: ""
        }
    );
}


function campusAIGetEmailLocalPart(email) {

    return String(email || "")
        .split("@")[0]
        .trim();
}


function campusAIGetEmailFirstName(email) {

    const local =
        campusAIGetEmailLocalPart(email);

    if (!local) return "";

    const token =
        local
            .split(/[._\-0-9]+/)
            .find(part => part.length > 0) ||
        local;

    return (
        token.charAt(0).toUpperCase() +
        token.slice(1)
    );
}


function campusAIGetEmailInitials(email) {

    const local =
        campusAIGetEmailLocalPart(email);

    if (!local) return "";

    const parts =
        local
            .split(/[._\-0-9]+/)
            .filter(part => part.length > 0);

    if (parts.length >= 2) {

        return (
            parts[0].charAt(0) +
            parts[1].charAt(0)
        ).toUpperCase();
    }

    if (parts.length === 1) {

        return parts[0]
            .slice(0, 2)
            .toUpperCase();
    }

    return local
        .slice(0, 2)
        .toUpperCase();
}


async function campusAIHashPassword(password) {

    if (
        window.crypto &&
        crypto.subtle &&
        window.TextEncoder
    ) {

        const data = new TextEncoder().encode(password);

        const hashBuffer = await crypto.subtle.digest(
            "SHA-256",
            data
        );

        return Array.from(
            new Uint8Array(hashBuffer)
        )
            .map(byte =>
                byte.toString(16).padStart(2, "0")
            )
            .join("");
    }

    /*
       Fallback for older browsers.
       This is only a local/demo account system.
    */

    return btoa(unescape(encodeURIComponent(password)));
}


/* =========================================================
   7. LOCAL STORAGE - CHATS
   ========================================================= */

function campusAILoadChats() {

    try {

        campusAIChats = JSON.parse(
            localStorage.getItem(
                CAMPUS_AI_STORAGE_KEY
            ) || "[]"
        );

        if (!Array.isArray(campusAIChats)) {
            campusAIChats = [];
        }

    } catch {

        campusAIChats = [];
    }

    /*
       BUG FIX: this used to auto-resume whichever chat had
       the most recent updatedAt, however long ago that was -
       so opening the AI after hours away silently continued
       an old conversation instead of starting fresh. A new
       message then got appended onto that old, often very
       long history and sent to the model together with it,
       which is a big part of why answers could end up
       sounding like they were addressing something asked
       hours earlier - the model was still holding that whole
       old exchange in context. Old chats are still saved and
       reachable from the sidebar/history list; the widget
       just no longer jumps back into one automatically.
    */

    campusAIHistory = [];
    campusAICurrentChatId = null;
    campusAIActiveDocuments = [];
}


function campusAISaveChats() {

    localStorage.setItem(
        CAMPUS_AI_STORAGE_KEY,
        JSON.stringify(campusAIChats)
    );
}


/* =========================================================
   8. NEW CHAT
   ========================================================= */

function newCampusAIChat() {

    stopCampusAI();

    campusAIHistory = [];
    campusAICurrentChatId = null;
    campusAIActiveDocuments = [];

    campusAIClearUploadedFiles();

    campusAIRenderMessages();
    campusAIRenderWelcome();
    campusAIRenderHistory();

    closeCampusAISidebar();
    closeCampusAIMoreMenu();

    const input = campusAI$("campusAiInput");

    if (input) {
        input.value = "";
        campusAIResizeInput();
    }

    campusAIUpdateSendState();
}


/* =========================================================
   9. WELCOME
   ========================================================= */

function campusAIRenderWelcome() {

    const messages = campusAI$("campusAiMessages");

    if (!messages) return;

    if (campusAIHistory.length > 0) {
        const welcome =
            messages.querySelector(
                ".campus-ai-welcome"
            );

        if (welcome) {
            welcome.remove();
        }

        return;
    }

    if (
        messages.querySelector(
            ".campus-ai-welcome"
        )
    ) {
        return;
    }

    const welcome =
        document.createElement("div");

    welcome.className =
        "campus-ai-welcome";

    const account =
        campusAIGetCurrentAccount();

    const firstName =
        account.id !== "guest"
            ? campusAIGetEmailFirstName(
                account.email
            )
            : "";

    const heading =
        firstName
            ? `Hello, ${campusAIEscapeHTML(firstName)}. How can I help you?`
            : "How can I help you?";

    welcome.innerHTML = `
        <div class="campus-ai-big-logo">🤖</div>

        <h1>${heading}</h1>

        <p>
            I am Kenyan Campus AI. Ask me about
            campus life, academics, coding,
            mathematics, business and more.
        </p>

        <div class="campus-ai-welcome-features">
            <span class="campus-ai-feature">🎓 Campus</span>
            <span class="campus-ai-feature">📚 Academics</span>
            <span class="campus-ai-feature">💻 Coding</span>
            <span class="campus-ai-feature">🧮 Mathematics</span>
        </div>

        <div class="campus-ai-suggestions">

            <button
                type="button"
                onclick="campusAISuggestion('Explain this topic step by step')">
                📚 Explain a topic
            </button>

            <button
                type="button"
                onclick="campusAISuggestion('Help me solve this mathematics question step by step')">
                🧮 Solve mathematics
            </button>

            <button
                type="button"
                onclick="campusAISuggestion('Help me write HTML, CSS and JavaScript code')">
                💻 Help with coding
            </button>

            <button
                type="button"
                onclick="campusAISuggestion('Help me understand this accounting question')">
                📊 Accounting help
            </button>

        </div>
    `;

    messages.appendChild(welcome);
}


/* =========================================================
   10. INPUT
   ========================================================= */

function clearCampusAIInput() {

    const input = campusAI$("campusAiInput");

    if (!input) return;

    input.value = "";

    campusAIResizeInput();
    campusAIUpdateSendState();
    input.focus();
}


function campusAIResizeInput() {

    const input = campusAI$("campusAiInput");

    if (!input) return;

    input.style.height = "auto";

    input.style.height =
        Math.min(input.scrollHeight, 180) + "px";
}


function handleCampusAIKey(event) {

    if (event.key === "Enter" && !event.shiftKey) {

        event.preventDefault();

        sendCampusAI();
    }
}


/* =========================================================
   11. CHAT CREATION
   ========================================================= */

function createCampusAIChatIfNeeded() {

    if (campusAICurrentChatId) {

        const existing =
            campusAIChats.find(
                chat =>
                    chat.id ===
                    campusAICurrentChatId
            );

        if (existing) {
            return existing;
        }
    }

    const accountId =
        campusAIGetCurrentAccountId();

    const chat = {

        id: campusAIUid("chat"),

        accountId,

        title: "New conversation",

        summary: "New student conversation",

        messages: [],

        documents: [],

        createdAt:
            new Date().toISOString(),

        updatedAt:
            new Date().toISOString()
    };

    campusAIChats.unshift(chat);

    campusAICurrentChatId = chat.id;

    campusAISaveChats();

    return chat;
}


function campusAIGetChat() {

    if (!campusAICurrentChatId) {
        return null;
    }

    return campusAIChats.find(
        chat =>
            chat.id ===
            campusAICurrentChatId
    ) || null;
}


function campusAIUpdateChatMetadata() {

    const chat = campusAIGetChat();

    if (!chat) return;

    const firstUser =
        campusAIHistory.find(
            message =>
                message.role === "user"
        );

    if (firstUser) {

        const words =
            firstUser.content
                .trim()
                .split(/\s+/)
                .slice(0, 7);

        chat.title =
            words.join(" ") ||
            "New conversation";
    }

    chat.messages =
        [...campusAIHistory];

    chat.documents =
        [...campusAIActiveDocuments];

    chat.updatedAt =
        new Date().toISOString();

    /*
       Immediate, synchronous fallback summary so the
       sidebar always shows SOMETHING useful right away,
       instead of staying on "New conversation" until (or
       unless) the AI metadata call below succeeds.
    */
    if (
        firstUser &&
        (!chat.summary ||
            chat.summary === "New student conversation")
    ) {

        chat.summary =
            firstUser.content
                .trim()
                .replace(/\s+/g, " ")
                .slice(0, 90);
    }

    campusAISaveChats();

    campusAIRenderHistory();

    /*
       Refining the title/summary via an extra AI call on
       EVERY message both slows the app down (it competes
       with the real reply for the same backend) and is
       unnecessary once a chat already has a decent title.
       Only ask for it early on, then occasionally as the
       conversation grows.
    */
    const messageCount =
        campusAIHistory.length;

    const shouldRefineSummary =
        messageCount <= 2 ||
        messageCount % 6 === 0;

    if (shouldRefineSummary) {
        campusAIGenerateSummary(chat);
    }
}


/* =========================================================
   12. AI SUMMARY
   ========================================================= */

async function campusAIGenerateSummary(chat) {

    if (!chat) return;

    if (
        campusAISummaryInFlight.has(chat.id)
    ) {
        return;
    }

    campusAISummaryInFlight.add(chat.id);

    try {

        const messages =
            chat.messages.slice(-8);

        const prompt = `
Create metadata for this student conversation.

Return EXACTLY:

TITLE: <maximum 6 words>
SUMMARY: <maximum 90 characters, short natural phrase describing what the conversation is about, e.g. "Greeting exchange" for a simple hi/hello, "Help with calculus homework" for a maths question>

Do not answer the conversation.
Do not include the conversation itself.
Do not add explanations.

Conversation:
${messages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n")}
`;

        const response = await fetch(
            "/api/ai",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json"
                },
                body: JSON.stringify({
                    message: prompt,
                    history: []
                })
            }
        );

        if (!response.ok) return;

        /*
           BUG FIX (sidebar always showed the generic word
           "Conversation", never an actual summary like
           "Greeting exchange"):

           This used to call response.json() and read
           data.reply, as if /api/ai replied with a JSON
           object. But /api/ai always streams its answer back
           as plain text (see campusAIReadFullResponse) - it
           never returns JSON for a normal question. Calling
           .json() on a plain-text body throws a SyntaxError
           every single time, which the catch block below
           swallowed silently - so campusAIGenerateSummary
           silently failed on EVERY chat, chat.summary was
           never set, and campusAIRenderHistory's fallback
           (chat.summary || "Conversation") is what actually
           showed up in the sidebar, no matter what the
           conversation was about.

           Read the body as plain text instead, matching what
           the endpoint actually sends.
        */

        const text =
            await response.text();

        const titleMatch =
            text.match(
                /TITLE:\s*(.+)/i
            );

        const summaryMatch =
            text.match(
                /SUMMARY:\s*(.+)/i
            );

        if (titleMatch) {

            chat.title =
                titleMatch[1]
                    .trim()
                    .replace(/\s+/g, " ")
                    .split(/\s+/)
                    .slice(0, 6)
                    .join(" ");
        }

        if (summaryMatch) {

            chat.summary =
                summaryMatch[1]
                    .trim()
                    .slice(0, 90);
        }

        chat.updatedAt =
            new Date().toISOString();

        campusAISaveChats();

        campusAIRenderHistory();

    } catch (error) {

        console.warn(
            "Conversation summary failed:",
            error
        );

    } finally {

        campusAISummaryInFlight.delete(
            chat.id
        );
    }
}


/* =========================================================
   13. RECENT CONVERSATIONS
   IMPORTANT:
   ONLY THE SHORT SUMMARY IS SHOWN
   ========================================================= */

function campusAIRenderHistory(
    searchTerm = ""
) {

    const history =
        campusAI$("campusAiHistory");

    if (!history) return;

    const accountId =
        campusAIGetCurrentAccountId();

    const term =
        searchTerm
            .trim()
            .toLowerCase();

    const chats =
        campusAIChats
            .filter(
                chat =>
                    chat.accountId ===
                    accountId
            )
            .filter(chat => {

                if (!term) return true;

                return (
                    String(chat.title || "")
                        .toLowerCase()
                        .includes(term) ||
                    String(chat.summary || "")
                        .toLowerCase()
                        .includes(term)
                );
            })
            .sort(
                (a, b) =>
                    new Date(b.updatedAt) -
                    new Date(a.updatedAt)
            );

    history.innerHTML = "";

    if (!chats.length) {

        history.innerHTML = `
            <div class="campus-ai-history-empty">
                No recent conversations
            </div>
        `;

        return;
    }

    chats.forEach(chat => {

        const item =
            document.createElement("button");

        item.type = "button";

        item.className =
            "campus-ai-history-item";

        if (
            chat.id ===
            campusAICurrentChatId
        ) {
            item.classList.add("active");
        }

        /*
           ONLY the short summary is shown
           (e.g. "Greeting exchange").
           NEVER insert chat messages here.
        */

        item.classList.add(
            "campus-ai-history-item-flat"
        );

        item.innerHTML = `
            <span class="campus-ai-history-summary">
                ${campusAIEscapeHTML(
                    chat.summary ||
                    "Conversation"
                )}
            </span>
        `;

        item.addEventListener(
            "click",
            () => loadCampusAIChat(chat.id)
        );

        history.appendChild(item);
    });
}


function searchCampusAIChats(event) {

    const value =
        event?.target?.value || "";

    campusAIRenderHistory(value);
}


function loadCampusAIChat(chatId) {

    const accountId =
        campusAIGetCurrentAccountId();

    const chat =
        campusAIChats.find(
            item =>
                item.id === chatId &&
                item.accountId === accountId
        );

    if (!chat) return;

    stopCampusAI();

    campusAICurrentChatId =
        chat.id;

    campusAIHistory =
        Array.isArray(chat.messages)
            ? [...chat.messages]
            : [];

    campusAIActiveDocuments =
        Array.isArray(chat.documents)
            ? [...chat.documents]
            : [];

    campusAIUploadedDocuments = [];

    campusAIRenderMessages();
    campusAIRenderHistory();

    closeCampusAISidebar();
    closeCampusAIMoreMenu();

    campusAIUpdateSendState();
}


function renderCampusAIMessagesFromHistory() {
    campusAIRenderMessages();
}


function campusAIRenderMessages() {

    const messages =
        campusAI$("campusAiMessages");

    if (!messages) return;

    messages.innerHTML = "";

    campusAIHistory.forEach(message => {

        campusAIAddMessageElement(
            message.role,
            message.content,
            false
        );
    });

    if (!campusAIHistory.length) {
        campusAIRenderWelcome();
    }

    campusAIScrollToBottom();
}


/* =========================================================
   14. MESSAGE RENDERING
   ========================================================= */

function campusAIAddMessageElement(
    role,
    content,
    scroll = true
) {

    const messages =
        campusAI$("campusAiMessages");

    if (!messages) return null;

    const row =
        document.createElement("div");

    row.className =
        `campus-ai-message ${role}`;

    const contentElement =
        document.createElement("div");

    contentElement.className =
        "campus-ai-message-content";

    if (role === "user") {

        contentElement.textContent =
            content;

    } else {

        contentElement.innerHTML =
            campusAIRenderMarkdown(content);

        campusAIAddResponseActions(
            row
        );
    }

    row.appendChild(contentElement);

    messages.appendChild(row);

    if (scroll) {
        campusAIScrollToBottom();
    }

    return row;
}


function addCampusAIMessageToUI(
    role,
    content,
    scroll = true
) {
    return campusAIAddMessageElement(
        role,
        content,
        scroll
    );
}


function campusAIAddResponseActions(row) {

    const actions =
        document.createElement("div");

    actions.className =
        "campus-ai-message-actions";

    actions.innerHTML = `
        <button
            type="button"
            title="Copy answer"
            aria-label="Copy answer"
            onclick="copyCampusAIAnswer(this)">
            ▣
        </button>

        <button
            type="button"
            title="Listen"
            aria-label="Listen"
            onclick="readCampusAIAnswer(this)">
            🔊
        </button>

        <button
            type="button"
            title="Regenerate"
            aria-label="Regenerate"
            onclick="regenerateCampusAI(this)">
            ↻
        </button>

        <button
            type="button"
            title="Good response"
            aria-label="Good response"
            onclick="rateCampusAIMessage(this, 'up')">
            👍
        </button>

        <button
            type="button"
            title="Bad response"
            aria-label="Bad response"
            onclick="rateCampusAIMessage(this, 'down')">
            👎
        </button>
    `;

    row.appendChild(actions);
}


/* =========================================================
   15. MARKDOWN
   ========================================================= */

/*
   Detects runs of unfenced but clearly code-like lines
   (2 or more in a row) and wraps them in ``` fences so
   they get code-block treatment. Leaves text alone if it
   already has any ``` fences, to avoid double-wrapping or
   fighting with a model that already formats correctly.
*/
function campusAIAutoWrapUnfencedCode(text) {

    if (text.includes("```")) return text;

    const listOrHeading =
        /^\s*([-*]|\d+[.)]|#{1,6}|>)\s/;

    const codeKeyword =
        /^\s*(function\b|const\b|let\b|var\b|def\b|class\b|public\b|private\b|protected\b|static\b|import\b|from\b|package\b|#include|<\?php|echo\s|print\(|console\.log|SELECT\s|INSERT\s|UPDATE\s|DELETE\s|return\b|if\s*\(|for\s*\(|while\s*\(|catch\s*\(|try\s*\{|\}\s*$|\{\s*$)/i;

    const semicolonEnd = /;\s*$/;
    const indented = /^ {2,}\S/;

    const isCodeLine = line => {

        if (!line.trim()) return false;
        if (listOrHeading.test(line)) return false;

        return (
            codeKeyword.test(line) ||
            semicolonEnd.test(line) ||
            indented.test(line)
        );
    };

    const lines = text.split("\n");
    const result = [];
    let buffer = [];

    const flush = () => {

        if (buffer.length >= 2) {

            result.push("```");
            result.push(...buffer);
            result.push("```");

        } else {

            result.push(...buffer);
        }

        buffer = [];
    };

    lines.forEach(line => {

        if (isCodeLine(line)) {
            buffer.push(line);
        } else {
            flush();
            result.push(line);
        }
    });

    flush();

    return result.join("\n");
}


/*
   Splits one "| a | b | c |" line into ["a", "b", "c"],
   stripping the optional leading/trailing pipe.
*/
function campusAIParseTableCells(line) {

    let trimmed =
        line.trim();

    if (trimmed.startsWith("|")) {
        trimmed = trimmed.slice(1);
    }

    if (trimmed.endsWith("|")) {
        trimmed = trimmed.slice(0, -1);
    }

    return trimmed
        .split("|")
        .map(cell => cell.trim());
}


/*
   A Markdown table separator row looks like
   "| --- | :--- | ---: | :---: |" - dashes with optional
   leading/trailing colons per column, for
   left/right/center alignment.
*/
function campusAIIsTableSeparatorRow(line) {

    const trimmed =
        line.trim();

    if (!trimmed.includes("-")) {
        return false;
    }

    return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(
        trimmed
    );
}


function campusAIRenderMarkdown(markdown) {

    if (!markdown) return "";

    let text =
        String(markdown)
            .replace(/\r\n/g, "\n");

    /*
       Some replies contain real code but never wrap it in
       ``` fences (depends on what the backend model felt
       like doing that turn). Without a fence, the code
       block feature below never triggers, so multi-line
       code just gets flattened into plain paragraphs -
       whitespace/indentation collapsed, no monospace font,
       no "Copy code" button. This detects runs of
       code-looking lines and fences them automatically so
       they get the same treatment as properly-fenced code.
    */
    text = campusAIAutoWrapUnfencedCode(text);

    const codeBlocks = [];

    text = text.replace(
        /```([\w#+.-]*)\n?([\s\S]*?)```/g,
        function (_, language, code) {

            const id =
                campusAIUid("code");

            codeBlocks.push({
                id,
                language:
                    language || "code",
                code
            });

            return `@@CAMPUS_CODE_${id}@@`;
        }
    );

    /*
       Defensive cleanup for artifacts that come from the
       backend's own JSON encoding rather than real Markdown
       - most commonly a JSON serializer (PHP's json_encode
       without JSON_UNESCAPED_SLASHES is the classic cause)
       escaping every "/" as "\/". Left alone, that shows up
       as a stray backslash in front of every slash all
       through normal sentences, dates and URLs. This runs
       AFTER code blocks are pulled out above, so it never
       touches code (where an escaped slash could be
       intentional, e.g. inside a regex literal).
    */
    text = text.replace(/\\\//g, "/");

    text =
        campusAIEscapeHTML(text);

    text = text.replace(
        /`([^`]+)`/g,
        "<code>$1</code>"
    );

    text = text.replace(
        /^### (.+)$/gm,
        "<h4>$1</h4>"
    );

    text = text.replace(
        /^## (.+)$/gm,
        "<h3>$1</h3>"
    );

    text = text.replace(
        /^# (.+)$/gm,
        "<h2>$1</h2>"
    );

    text = text.replace(
        /\*\*(.+?)\*\*/g,
        "<strong>$1</strong>"
    );

    text = text.replace(
        /\*(.+?)\*/g,
        "<em>$1</em>"
    );

    const lines =
        text.split("\n");

    let output = "";
    let inList = false;
    let listTag = "";

    /*
       BUG FIX: this used to be a plain forEach with no table
       support at all - a Markdown table like
       "| Account | Debit | Credit |" was never recognized,
       so every "|" just landed in its own <p> as raw text.
       That's a big part of why accounting layouts (journal
       entries, ledgers, trial balances) the AI is now
       instructed to format as tables still looked like an
       unformatted wall of pipe characters. This is now an
       indexed loop instead of forEach specifically so it can
       look ahead: a line containing "|" immediately followed
       by a "---" separator line is treated as a table header,
       and every following pipe-row becomes a table body row,
       right up to the first blank/non-table line.
    */
    let i = 0;

    while (i < lines.length) {

        const line = lines[i];

        if (
            line.includes("|") &&
            i + 1 < lines.length &&
            campusAIIsTableSeparatorRow(
                lines[i + 1]
            )
        ) {

            if (inList) {
                output += `</${listTag}>`;
                inList = false;
            }

            const headerCells =
                campusAIParseTableCells(line);

            const alignments =
                campusAIParseTableCells(
                    lines[i + 1]
                ).map(cell => {

                    const left =
                        cell.startsWith(":");

                    const right =
                        cell.endsWith(":");

                    if (left && right) return "center";
                    if (right) return "right";
                    if (left) return "left";
                    return "";
                });

            const bodyRows = [];

            let j = i + 2;

            while (
                j < lines.length &&
                lines[j].includes("|") &&
                lines[j].trim() !== ""
            ) {

                bodyRows.push(
                    campusAIParseTableCells(
                        lines[j]
                    )
                );

                j++;
            }

            let tableHTML =
                '<div class="campus-ai-table-wrap"><table class="campus-ai-table"><thead><tr>';

            headerCells.forEach((cell, index) => {

                const align =
                    alignments[index];

                const style =
                    align
                        ? ` style="text-align:${align}"`
                        : "";

                tableHTML +=
                    `<th${style}>${cell}</th>`;
            });

            tableHTML +=
                "</tr></thead><tbody>";

            bodyRows.forEach(row => {

                tableHTML += "<tr>";

                headerCells.forEach((_, index) => {

                    const align =
                        alignments[index];

                    const style =
                        align
                            ? ` style="text-align:${align}"`
                            : "";

                    tableHTML +=
                        `<td${style}>${row[index] ?? ""}</td>`;
                });

                tableHTML += "</tr>";
            });

            tableHTML +=
                "</tbody></table></div>";

            output += tableHTML;

            i = j;

            continue;
        }

        const bulletMatch =
            line.match(/^\s*[-*]\s+(.+)$/);

        const orderedMatch =
            !bulletMatch &&
            line.match(/^\s*\d+[.)]\s+(.+)$/);

        const listMatch =
            bulletMatch || orderedMatch;

        const currentTag =
            orderedMatch ? "ol" : "ul";

        if (listMatch) {

            if (inList && listTag !== currentTag) {

                output += `</${listTag}>`;
                inList = false;
            }

            if (!inList) {

                output += `<${currentTag}>`;
                inList = true;
                listTag = currentTag;
            }

            output +=
                `<li>${listMatch[1]}</li>`;

            i++;
            continue;
        }

        if (inList) {

            output += `</${listTag}>`;
            inList = false;
        }

        if (!line.trim()) {

            output += "<br>";
            i++;
            continue;
        }

        if (
            /^<h[234]>/.test(line)
        ) {

            output += line;
            i++;
            continue;
        }

        output +=
            `<p>${line}</p>`;

        i++;
    }

    if (inList) {
        output += `</${listTag}>`;
    }

    codeBlocks.forEach(block => {

        const safeCode =
            campusAIEscapeHTML(
                block.code
            );

        const placeholder =
            `@@CAMPUS_CODE_${block.id}@@`;

        const codeHTML = `
            <div class="campus-ai-code-block">

                <div class="campus-ai-code-header">

                    <span class="campus-ai-code-language">
                        ${campusAIEscapeHTML(
                            block.language
                        )}
                    </span>

                    <button
                        type="button"
                        class="campus-ai-copy-code"
                        title="Copy code"
                        aria-label="Copy code"
                        data-code-id="${block.id}"
                        onclick="copyCampusAICode(this)">
                        <span>▣</span>
                        <span>Copy code</span>
                    </button>

                </div>

                <pre><code
                    data-campus-code-id="${block.id}"
                    data-campus-code="${campusAIEscapeAttribute(
                        block.code
                    )}">${safeCode}</code></pre>

            </div>
        `;

        output =
            output.replace(
                placeholder,
                codeHTML
            );
    });

    return output;
}


/* =========================================================
   16. SCROLL
   ========================================================= */

function campusAIScrollToBottom() {

    const body =
        campusAI$("campusAiBody");

    const messages =
        campusAI$("campusAiMessages");

    if (body) {
        body.scrollTop =
            body.scrollHeight;
    }

    if (messages) {
        messages.scrollTop =
            messages.scrollHeight;
    }
}


/* =========================================================
   17. THINKING
   ========================================================= */

function campusAIShowThinking() {

    campusAIRemoveThinking();

    const messages =
        campusAI$("campusAiMessages");

    if (!messages) return;

    const thinking =
        document.createElement("div");

    thinking.className =
        "campus-ai-thinking";

    thinking.innerHTML = `
        <div class="campus-ai-thinking-dots">
            <span></span>
            <span></span>
            <span></span>
        </div>
    `;

    messages.appendChild(thinking);

    campusAIScrollToBottom();
}


function campusAIRemoveThinking() {

    document
        .querySelectorAll(
            ".campus-ai-thinking"
        )
        .forEach(element =>
            element.remove()
        );
}


/* =========================================================
   18. SEND ICON
   ========================================================= */

function campusAISetSendIcon() {

    const button =
        campusAI$("campusAiSend");

    if (!button) return;

    button.innerHTML = `
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true">
            <path
                d="M22 2L11 13"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"/>
            <path
                d="M22 2L15 22L11 13L2 9L22 2Z"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"/>
        </svg>
    `;
}


/* =========================================================
   19. SEND / STOP BUTTON
   ========================================================= */

function campusAISetActionButtonGenerating(
    generating
) {

    const send =
        campusAI$("campusAiSend");

    const toolbar =
        document.querySelector(
            ".campus-ai-toolbar-right"
        );

    if (!send || !toolbar) return;

    let stop =
        campusAI$("campusAiStop");

    if (generating) {

        send.style.display = "none";

        if (!stop) {

            stop =
                document.createElement("button");

            stop.id =
                "campusAiStop";

            stop.type = "button";

            stop.className =
                "campus-ai-stop-button";

            stop.title =
                "Stop generating";

            stop.setAttribute(
                "aria-label",
                "Stop generating"
            );

            stop.innerHTML = `
                <span>■</span>
            `;

            toolbar.appendChild(stop);

            stop.addEventListener(
                "click",
                stopCampusAI
            );
        }

        stop.style.display = "inline-flex";

    } else {

        send.style.display =
            "inline-flex";

        if (stop) {
            stop.style.display = "none";
        }
    }
}


function campusAIUpdateSendState() {

    const send =
        campusAI$("campusAiSend");

    if (!send) return;

    const input =
        campusAI$("campusAiInput");

    const hasText =
        !!input?.value.trim();

    const hasFiles =
        campusAIUploadedDocuments.length > 0;

    send.disabled =
        campusAIThinking ||
        (!hasText && !hasFiles);
}


/* =========================================================
   20. SEND NORMAL MESSAGE
   ========================================================= */

async function sendCampusAI() {

    if (campusAIThinking) return;

    const input =
        campusAI$("campusAiInput");

    let message =
        input?.value.trim() || "";

    const stagedFiles =
        [...campusAIUploadedDocuments];

    if (!message && !stagedFiles.length) {
        return;
    }

    if (stagedFiles.length) {

        const uploaded =
            await campusAIProcessUploadedFiles(
                stagedFiles
            );

        campusAIActiveDocuments = [
            ...campusAIActiveDocuments,
            ...uploaded
        ];

        campusAIUploadedDocuments = [];

        campusAIRenderUploadedFiles();
    }

    if (!message) {

        if (
            campusAILikelyQuestionDocument(
                campusAIActiveDocuments
            )
        ) {

            message =
                "Answer the questions in the uploaded document. Show the working clearly, explain the answers step by step, and format your response with clear headings, numbered steps, and bold for key terms so it's easy to follow.";

        } else {

            message =
                "Summarize the uploaded document and tell me what you'd like me to do with it. Use clear headings and bullet points so it's easy to scan.";
        }
    }

    const chat =
        createCampusAIChatIfNeeded();

    campusAIHistory.push({
        role: "user",
        content: message
    });

    chat.messages =
        [...campusAIHistory];

    chat.documents =
        [...campusAIActiveDocuments];

    chat.updatedAt =
        new Date().toISOString();

    campusAISaveChats();

    campusAIRemoveWelcome();

    campusAIAddMessageElement(
        "user",
        message,
        true
    );

    if (input) {
        input.value = "";
        campusAIResizeInput();
    }

    campusAIThinking = true;

    campusAISetActionButtonGenerating(true);
    campusAIUpdateSendState();
    campusAIShowThinking();

    campusAIAbortController =
        new AbortController();

    /*
       Without any timeout, a slow/stuck backend just left
       the "thinking" dots spinning forever with zero
       feedback - which reads as "taking long to connect".
       This fails loudly after a reasonable wait instead,
       so the person at least knows to retry rather than
       staring at a frozen screen.
    */
    let campusAITimedOut = false;

    const timeoutId = setTimeout(() => {

        campusAITimedOut = true;
        campusAIAbortController?.abort();

    }, 60000);

    try {

        const response =
            await fetch(
                "/api/ai",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                        "Accept":
                            "text/event-stream, application/json, text/plain"
                    },

                    body: JSON.stringify({
                        message,
                        history:
                            campusAIHistory.slice(
                                0,
                                -1
                            ),
                        documents:
                            campusAIActiveDocuments
                    }),

                    signal:
                        campusAIAbortController.signal
                }
            );

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        campusAIRemoveThinking();

        const assistantRow =
            campusAIAddStreamingAssistant();

        const assistantText =
            await campusAIReadFullResponse(
                response,
                text => {

                    campusAIUpdateStreamingAssistant(
                        assistantRow,
                        text
                    );
                }
            );

        if (!assistantText.trim()) {
            throw new Error(
                "Empty AI response"
            );
        }

        campusAIUpdateStreamingAssistant(
            assistantRow,
            assistantText
        );

        /*
           Add assistant exactly ONCE.
        */

        campusAIHistory.push({
            role: "assistant",
            content: assistantText
        });

        campusAIUpdateChatMetadata();

        if (
            campusAIVoiceSettings.autoRead
        ) {
            speakCampusAIText(
                campusAICleanSpeechText(
                    assistantText
                )
            );
        }

    } catch (error) {

        campusAIRemoveThinking();

        if (
            error.name === "AbortError" &&
            !campusAITimedOut
        ) {
            return;
        }

        console.error(
            "Campus AI error:",
            error
        );

        const errorMessage =
            campusAITimedOut
                ? "The AI server is taking too long to respond. It may be overloaded or slow right now - please try again."
                : "I could not connect to Kenyan Campus AI right now. Please make sure your AI server is running and try again.";

        campusAIAddMessageElement(
            "assistant",
            errorMessage,
            true
        );

        campusAIHistory.push({
            role: "assistant",
            content: errorMessage
        });

        campusAIUpdateChatMetadata();

    } finally {

        clearTimeout(timeoutId);

        campusAIThinking = false;
        campusAIAbortController = null;

        campusAISetActionButtonGenerating(
            false
        );

        campusAIUpdateSendState();
    }
}


/* =========================================================
   21. STREAMING
   Prevents duplicated/repeated streamed responses
   ========================================================= */

function campusAIAddStreamingAssistant() {

    const messages =
        campusAI$("campusAiMessages");

    const row =
        document.createElement("div");

    row.className =
        "campus-ai-message assistant";

    const content =
        document.createElement("div");

    content.className =
        "campus-ai-message-content";

    content.innerHTML = "";

    row.appendChild(content);

    /*
       IMPORTANT FIX:
       Action buttons (copy, listen, regenerate,
       thumbs up/down) must be attached here too,
       not only on history-loaded messages, or a
       freshly streamed answer never gets them.
    */

    campusAIAddResponseActions(row);

    messages.appendChild(row);

    campusAIScrollToBottom();

    return row;
}


function campusAIUpdateStreamingAssistant(
    row,
    text
) {

    if (!row) return;

    const content =
        row.querySelector(
            ".campus-ai-message-content"
        );

    if (!content) return;

    content.innerHTML =
        campusAIRenderMarkdown(text);

    campusAIScrollToBottom();
}


async function campusAIReadFullResponse(
    response,
    onText
) {

    const contentType =
        response.headers.get(
            "content-type"
        ) || "";

    /*
       JSON response
    */

    if (
        contentType.includes(
            "application/json"
        )
    ) {

        const data =
            await response.json();

        const text =
            data.reply ||
            data.response ||
            data.message ||
            data.content ||
            "";

        onText(String(text));

        return String(text);
    }

    /*
       Stream response
    */

    if (!response.body) {

        const text =
            await response.text();

        onText(text);

        return text;
    }

    const reader =
        response.body.getReader();

    const decoder =
        new TextDecoder();

    /*
       BUG FIX (code/paragraphs collapsing onto one line):

       This used to unconditionally treat every decoded chunk
       as newline-delimited "lines" (buffer.split("\n"), one
       chunk parsed per line) - a format that only makes sense
       for a line-framed protocol like SSE, where each "\n" is
       a protocol delimiter between separate "data: ..." events,
       not literal content.

       Our /api/ai backend does not send SSE. It sends
       Content-Type: text/plain and writes the model's raw
       text straight to the response (res.write(token)) - so
       every "\n" byte in that stream IS part of the answer
       itself: a paragraph break, a list item boundary, a line
       inside a fenced code block, a row of a table, etc.

       Running that through the line-split parser silently
       consumed the "\n" as a delimiter and re-joined the
       pieces with campusAIMergeStreamChunk, which does plain
       concatenation with nothing put back in its place. The
       result: the assistant's full answer arrived with every
       real newline stripped out - fine for a single short
       sentence, but it meant multi-line code, tables, lists
       and paragraphs were all flattened into one continuous
       line. That looked wrong on screen, and "Copy code" /
       "Copy answer" (which read the already-flattened text)
       pasted as one unbroken line into VS Code too.

       Fix: only run the line-based "data:"/JSON parser when
       the response actually says it's an SSE stream. For a
       plain-text stream, decode chunks and append them to the
       running text exactly as received, newlines and all.
    */

    const isEventStream =
        contentType.includes(
            "text/event-stream"
        );

    let fullText = "";

    if (!isEventStream) {

        while (true) {

            const {
                value,
                done
            } = await reader.read();

            if (done) break;

            const chunk =
                decoder.decode(
                    value,
                    { stream: true }
                );

            if (!chunk) continue;

            fullText =
                campusAIMergeStreamChunk(
                    fullText,
                    chunk
                );

            onText(fullText);
        }

        const tail =
            decoder.decode();

        if (tail) {

            fullText =
                campusAIMergeStreamChunk(
                    fullText,
                    tail
                );

            onText(fullText);
        }

        return fullText;
    }

    /*
       SSE stream ("data: ..." events separated by real "\n"
       line framing) - the line-based parser below is correct
       here, since the newlines being split on are protocol
       framing, not answer content.
    */

    let buffer = "";

    while (true) {

        const {
            value,
            done
        } = await reader.read();

        if (done) break;

        buffer +=
            decoder.decode(
                value,
                { stream: true }
            );

        const lines =
            buffer.split("\n");

        buffer =
            lines.pop() || "";

        for (const rawLine of lines) {

            let line =
                rawLine.trim();

            if (!line) continue;

            if (
                line.startsWith(
                    "data:"
                )
            ) {
                line =
                    line.slice(5).trim();
            }

            if (
                line === "[DONE]"
            ) {
                continue;
            }

            let chunk = line;

            /*
               Handle JSON stream chunks.
            */

            try {

                const parsed =
                    JSON.parse(line);

                chunk =
                    parsed.delta ??
                    parsed.text ??
                    parsed.reply ??
                    parsed.content ??
                    "";

            } catch {
                /*
                   Plain text chunk.
                */
            }

            if (!chunk) continue;

            chunk = String(chunk);

            fullText =
                campusAIMergeStreamChunk(
                    fullText,
                    chunk
                );

            onText(fullText);
        }
    }

    if (buffer.trim()) {

        let chunk =
            buffer.trim();

        if (
            chunk.startsWith("data:")
        ) {
            chunk =
                chunk.slice(5).trim();
        }

        try {

            const parsed =
                JSON.parse(chunk);

            chunk =
                parsed.delta ??
                parsed.text ??
                parsed.reply ??
                parsed.content ??
                "";

        } catch {}

        if (chunk) {

            chunk = String(chunk);

            fullText =
                campusAIMergeStreamChunk(
                    fullText,
                    chunk
                );

            onText(fullText);
        }
    }

    return fullText;
}


/*
   Merges an incoming stream chunk into the text
   accumulated so far.

   Handles three cases that servers commonly send:
     1. A true delta (new text only) -> append it.
     2. A cumulative payload (chunk already contains
        everything sent so far, plus more) -> replace
        fullText with chunk.
     3. A re-sent duplicate of the tail end -> ignore
        just the overlapping part, not the whole chunk.

   The previous implementation used chunk.startsWith(fullText)
   / fullText.endsWith(chunk), which silently DROPPED any
   chunk that happened to end the same way fullText ended
   (e.g. two consecutive deltas that both end in "the" or
   "."), and this is the main cause of the repeated /
   garbled text people were seeing: dropped chunks meant
   words went missing, and the UI would then show a stale
   duplicate render of the previous state on the next tick.
*/
function campusAIMergeStreamChunk(fullText, chunk) {

    if (!fullText) return chunk;
    if (!chunk) return fullText;

    // Case 2: cumulative payload.
    if (chunk.startsWith(fullText)) {
        return chunk;
    }

    // Case 3: exact duplicate re-send of the tail.
    if (fullText.endsWith(chunk)) {
        return fullText;
    }

    /*
       Case 3b: partial overlap - the start of `chunk`
       repeats the end of `fullText` (common when a server
       re-sends a small window of already-sent text before
       continuing). Find the longest such overlap and only
       append the genuinely new part.
    */
    const maxOverlap =
        Math.min(fullText.length, chunk.length);

    for (let len = maxOverlap; len > 0; len--) {

        if (
            fullText.slice(-len) ===
            chunk.slice(0, len)
        ) {
            return fullText + chunk.slice(len);
        }
    }

    // Case 1: genuine new delta, no overlap detected.
    return fullText + chunk;
}


/* =========================================================
   22. REMOVE WELCOME
   ========================================================= */

function campusAIRemoveWelcome() {

    document
        .querySelectorAll(
            ".campus-ai-welcome"
        )
        .forEach(
            element => element.remove()
        );
}


/* =========================================================
   23. STOP
   ========================================================= */

function stopCampusAI() {

    if (campusAIAbortController) {

        try {
            campusAIAbortController.abort();
        } catch {}
    }

    campusAIAbortController = null;

    campusAIThinking = false;

    campusAIRemoveThinking();

    campusAISetActionButtonGenerating(
        false
    );

    campusAIUpdateSendState();
}


/* =========================================================
   24. COPY ANSWER
   ========================================================= */

async function copyCampusAIAnswer(button) {

    const row =
        button.closest(
            ".campus-ai-message"
        );

    if (!row) return;

    const content =
        row.querySelector(
            ".campus-ai-message-content"
        );

    if (!content) return;

    const text =
        content.innerText.trim();

    try {

        await navigator.clipboard.writeText(
            text
        );

        button.textContent = "✓";

        setTimeout(() => {
            button.textContent = "▣";
        }, 1200);

    } catch {

        campusAIFallbackCopy(text);
    }
}


/* =========================================================
   25. COPY CODE
   ========================================================= */

async function copyCampusAICode(button) {

    const block =
        button.closest(
            ".campus-ai-code-block"
        );

    if (!block) return;

    const code =
        block.querySelector(
            "pre code"
        );

    if (!code) return;

    /*
       textContent gives ONLY the code.
       Header/buttons are not copied.
    */

    const text =
        code.textContent;

    try {

        await navigator.clipboard.writeText(
            text
        );

        button.classList.add("copied");

        const original =
            button.innerHTML;

        button.innerHTML = `
            <span>✓</span>
            <span>Copied</span>
        `;

        setTimeout(() => {

            button.classList.remove(
                "copied"
            );

            button.innerHTML =
                original;

        }, 1400);

    } catch {

        campusAIFallbackCopy(text);
    }
}


function campusAIFallbackCopy(text) {

    const textarea =
        document.createElement("textarea");

    textarea.value = text;

    textarea.style.position =
        "fixed";

    textarea.style.opacity = "0";

    document.body.appendChild(
        textarea
    );

    textarea.select();

    try {
        document.execCommand("copy");
    } catch {}

    textarea.remove();
}


/* =========================================================
   26. REGENERATE
   ========================================================= */

async function regenerateCampusAI(button) {

    const row =
        button.closest(
            ".campus-ai-message"
        );

    if (!row) return;

    const rows =
        Array.from(
            document.querySelectorAll(
                "#campusAiMessages .campus-ai-message"
            )
        );

    const index =
        rows.indexOf(row);

    if (index < 0) return;

    let userMessage = null;

    for (
        let i = index - 1;
        i >= 0;
        i--
    ) {

        if (
            rows[i].classList.contains(
                "user"
            )
        ) {

            userMessage =
                rows[i]
                    .querySelector(
                        ".campus-ai-message-content"
                    )
                    ?.innerText ||
                null;

            break;
        }
    }

    if (!userMessage) return;

    /*
       BUG FIX: this used to only drop the last ASSISTANT
       message, then call sendCampusAI() below - which pushes
       the same user question onto history again as a brand
       new turn. That left the same question sitting in
       history twice (once from the original turn, once from
       the "regenerated" one), which the AI would then see
       twice in its own conversation context - showing up as
       it repeating or re-answering something already asked.
       Dropping both the assistant reply AND the user message
       it replied to means sendCampusAI() below re-adds the
       user message exactly once, like the first time.
    */

    campusAIHistory =
        campusAIHistory.slice(
            0,
            -2
        );

    campusAIRenderMessages();

    const input =
        campusAI$("campusAiInput");

    if (input) {
        input.value =
            userMessage;
    }

    await sendCampusAI();
}


/* =========================================================
   27. RATING
   ========================================================= */

function rateCampusAIMessage(
    button,
    rating
) {

    const row =
        button.closest(
            ".campus-ai-message"
        );

    if (!row) return;

    row.dataset.rating =
        rating;

    const buttons =
        row.querySelectorAll(
            ".campus-ai-message-actions button"
        );

    buttons.forEach(
        item =>
            item.classList.remove(
                "selected"
            )
    );

    button.classList.add(
        "selected"
    );
}


/* =========================================================
   28. SPEECH / SOUNDS
   ========================================================= */

function campusAILoadVoiceSettings() {

    try {

        const saved =
            JSON.parse(
                localStorage.getItem(
                    CAMPUS_AI_VOICE_SETTINGS_KEY
                ) || "{}"
            );

        campusAIVoiceSettings = {
            ...CAMPUS_AI_DEFAULT_VOICE_SETTINGS,
            ...saved
        };

    } catch {

        campusAIVoiceSettings = {
            ...CAMPUS_AI_DEFAULT_VOICE_SETTINGS
        };
    }

    /*
       ONE-TIME RESET: confirmed via diagnostic logging that
       autoRead was saved as true in some users' browsers,
       silently making every reply read itself aloud with no
       button press. Whatever turned it on originally (an
       earlier accidental tap, a since-fixed bug, etc.), this
       clears it back to off exactly once per browser so it
       stops being sticky - it does NOT stop someone from
       deliberately turning Auto-read back on afterward via
       Settings, this just guarantees nobody stays stuck with
       it on without having chosen it here, going forward.
    */
    const AUTOREAD_RESET_KEY =
        "kenyaCampusHubAIAutoReadResetV1";

    if (
        !localStorage.getItem(
            AUTOREAD_RESET_KEY
        )
    ) {

        campusAIVoiceSettings.autoRead = false;

        campusAISaveVoiceSettings();

        localStorage.setItem(
            AUTOREAD_RESET_KEY,
            "1"
        );
    }
}


function campusAISaveVoiceSettings() {

    localStorage.setItem(
        CAMPUS_AI_VOICE_SETTINGS_KEY,
        JSON.stringify(
            campusAIVoiceSettings
        )
    );
}


function campusAIGetSelectedVoice() {

    if (
        !("speechSynthesis" in window)
    ) {
        return null;
    }

    const voices =
        speechSynthesis.getVoices();

    if (!voices.length) return null;

    if (
        campusAIVoiceSettings.voiceURI
    ) {

        const selected =
            voices.find(
                voice =>
                    voice.voiceURI ===
                    campusAIVoiceSettings.voiceURI
            );

        if (selected) return selected;
    }

    const kenya =
        voices.find(
            voice =>
                voice.lang
                    ?.toLowerCase()
                    .includes("en-ke")
        );

    if (kenya) return kenya;

    const english =
        voices.find(
            voice =>
                voice.lang
                    ?.toLowerCase()
                    .startsWith("en")
        );

    return english || voices[0];
}


function speakCampusAIText(text) {

    if (
        !("speechSynthesis" in window)
    ) {
        return;
    }

    text =
        String(text || "").trim();

    if (!text) return;

    /*
       Stop microphone so Talk mode doesn't
       hear the AI speaking.
    */

    if (campusAIIsTalkOpen()) {
        stopCampusAITalkListening(false);
    }

    campusAISpeechToken++;

    const currentToken =
        campusAISpeechToken;

    speechSynthesis.cancel();

    campusAISpeaking = true;

    const utterance =
        new SpeechSynthesisUtterance(
            text
        );

    const voice =
        campusAIGetSelectedVoice();

    if (voice) {
        utterance.voice = voice;
    }

    utterance.rate =
        Number(
            campusAIVoiceSettings.rate
        );

    utterance.pitch =
        Number(
            campusAIVoiceSettings.pitch
        );

    utterance.volume =
        Number(
            campusAIVoiceSettings.volume
        );

    utterance.onend = function () {

        if (
            currentToken !==
            campusAISpeechToken
        ) {
            return;
        }

        campusAISpeaking = false;

        if (campusAIIsTalkOpen()) {

            setTimeout(
                () =>
                    startCampusAITalkListening(),
                400
            );
        }
    };

    utterance.onerror = function () {

        if (
            currentToken !==
            campusAISpeechToken
        ) {
            return;
        }

        campusAISpeaking = false;

        if (campusAIIsTalkOpen()) {
            setTimeout(
                () =>
                    startCampusAITalkListening(),
                400
            );
        }
    };

    speechSynthesis.speak(
        utterance
    );
}


/*
   Speaks one chunk of text WITHOUT cancelling whatever is
   already queued (speechSynthesis.speak() naturally plays
   multiple utterances back to back), so Talk mode can speak
   sentence-by-sentence as a reply streams in. Mic restart
   only happens once every queued sentence has finished.
*/
function campusAIQueueTalkSpeech(text) {

    if (!("speechSynthesis" in window)) return;

    text =
        campusAICleanSpeechText(text);

    if (!text) return;

    campusAISpeaking = true;
    campusAITalkSpeechQueueCount++;

    const utterance =
        new SpeechSynthesisUtterance(text);

    const voice =
        campusAIGetSelectedVoice();

    if (voice) {
        utterance.voice = voice;
    }

    utterance.rate =
        Number(campusAIVoiceSettings.rate);

    utterance.pitch =
        Number(campusAIVoiceSettings.pitch);

    utterance.volume =
        Number(campusAIVoiceSettings.volume);

    const finishOne = function () {

        campusAITalkSpeechQueueCount =
            Math.max(
                0,
                campusAITalkSpeechQueueCount - 1
            );

        if (campusAITalkSpeechQueueCount > 0) {
            return;
        }

        campusAISpeaking = false;

        if (campusAIIsTalkOpen()) {

            campusAITalkShouldListen = true;

            setTimeout(
                () =>
                    startCampusAITalkListening(),
                150
            );
        }
    };

    utterance.onend = finishOne;
    utterance.onerror = finishOne;

    speechSynthesis.speak(utterance);
}


/*
   Matches emoji / pictographic characters so they
   can be stripped before text is spoken aloud.
   Covers common emoji blocks, symbols, dingbats,
   flags, skin-tone modifiers and variation selectors.
*/
const CAMPUS_AI_EMOJI_REGEX =
    /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;


function campusAIStripEmoji(text) {

    return String(text || "")
        .replace(CAMPUS_AI_EMOJI_REGEX, "")
        .replace(/\s+/g, " ")
        .trim();
}


function campusAICleanSpeechText(text) {

    return campusAIStripEmoji(
        String(text || "")
            .replace(
                /```[\s\S]*?```/g,
                " code omitted "
            )
            .replace(
                /`([^`]+)`/g,
                "$1"
            )
            .replace(
                /https?:\/\/\S+/gi,
                " link "
            )
            .replace(
                /[#*_>]/g,
                ""
            )
            .replace(
                /\s+/g,
                " "
            )
            .trim()
    );
}


function readCampusAIAnswer(button) {

    const row =
        button.closest(
            ".campus-ai-message"
        );

    if (!row) return;

    const content =
        row.querySelector(
            ".campus-ai-message-content"
        );

    if (!content) return;

    const text =
        campusAICleanSpeechText(
            content.innerText
        );

    speakCampusAIText(text);
}


/*
   Browsers don't expose a reliable gender field
   on voices, so we guess from the voice name using
   common naming patterns from the major platforms.
*/
const CAMPUS_AI_FEMALE_VOICE_HINTS = [
    "female", "woman", "zira", "samantha", "susan",
    "victoria", "karen", "moira", "tessa", "fiona",
    "veena", "salli", "joanna", "kimberly", "kendra",
    "ivy", "aria", "jenny", "libby", "olivia", "emma",
    "amy", "nicole", "monica", "paulina", "google uk english female",
    "google us english"
];

const CAMPUS_AI_MALE_VOICE_HINTS = [
    "male", "man", "daniel", "alex", "fred", "george",
    "david", "mark", "james", "ryan", "guy", "eric",
    "brian", "arthur", "google uk english male"
];


function campusAIGuessVoiceGender(voice) {

    const name =
        (voice?.name || "")
            .toLowerCase();

    if (
        CAMPUS_AI_FEMALE_VOICE_HINTS.some(
            hint => name.includes(hint)
        )
    ) {
        return "female";
    }

    if (
        CAMPUS_AI_MALE_VOICE_HINTS.some(
            hint => name.includes(hint)
        )
    ) {
        return "male";
    }

    return "other";
}


function populateCampusAIVoices() {

    const select =
        campusAI$("campusAiVoiceSelect");

    if (!select) return;

    if (
        !("speechSynthesis" in window)
    ) return;

    const voices =
        speechSynthesis.getVoices();

    select.innerHTML = "";

    const groups = {
        female: document.createElement("optgroup"),
        male: document.createElement("optgroup"),
        other: document.createElement("optgroup")
    };

    groups.female.label = "Women's voices";
    groups.male.label = "Men's voices";
    groups.other.label = "Other voices";

    voices.forEach(voice => {

        const option =
            document.createElement(
                "option"
            );

        option.value =
            voice.voiceURI;

        option.textContent =
            `${voice.name} (${voice.lang})`;

        if (
            voice.voiceURI ===
            campusAIVoiceSettings.voiceURI
        ) {
            option.selected = true;
        }

        const gender =
            campusAIGuessVoiceGender(voice);

        groups[gender].appendChild(
            option
        );
    });

    [groups.female, groups.male, groups.other]
        .forEach(group => {

            if (group.children.length) {
                select.appendChild(group);
            }
        });

    if (
        !campusAIVoiceSettings.voiceURI &&
        voices.length
    ) {

        const selected =
            campusAIGetSelectedVoice();

        if (selected) {
            select.value =
                selected.voiceURI;
        }
    }
}


/*
   Wires up the settings modal's voice/rate/pitch/volume/
   autoRead controls. Previously NONE of these had any
   event listener at all, so picking a voice, or dragging
   a slider, never actually changed anything - the app just
   kept using whatever it had defaulted to. This is called
   exactly once, right after the modal's HTML is first
   created, so listeners are never attached twice.
*/
function campusAIBindVoiceSettingsControls() {

    const select =
        campusAI$("campusAiVoiceSelect");

    const rate =
        campusAI$("campusAiVoiceRate");

    const pitch =
        campusAI$("campusAiVoicePitch");

    const volume =
        campusAI$("campusAiVoiceVolume");

    const autoRead =
        campusAI$("campusAiAutoRead");

    if (select) {
        select.addEventListener(
            "change",
            () =>
                campusAISelectVoice(
                    select.value
                )
        );
    }

    if (rate) {
        rate.addEventListener(
            "input",
            () =>
                campusAIUpdateVoiceOverride(
                    "rate",
                    rate.value
                )
        );
    }

    if (pitch) {
        pitch.addEventListener(
            "input",
            () =>
                campusAIUpdateVoiceOverride(
                    "pitch",
                    pitch.value
                )
        );
    }

    if (volume) {
        volume.addEventListener(
            "input",
            () =>
                campusAIUpdateVoiceOverride(
                    "volume",
                    volume.value
                )
        );
    }

    if (autoRead) {
        autoRead.addEventListener(
            "change",
            () => {

                campusAIVoiceSettings.autoRead =
                    autoRead.checked;

                campusAISaveVoiceSettings();
            }
        );
    }
}


/*
   Called when the user picks a different voice from the
   dropdown. Switches to that voice's OWN remembered
   pitch/rate/volume (or neutral defaults, if this voice
   has never been tuned before) instead of carrying over
   whatever the previous voice happened to be set to.
*/
function campusAISelectVoice(voiceURI) {

    campusAIVoiceSettings.voiceURI = voiceURI;

    const saved =
        campusAIVoiceSettings.voiceOverrides[
            voiceURI
        ] || { rate: 1, pitch: 1, volume: 1 };

    campusAIVoiceSettings.rate = saved.rate;
    campusAIVoiceSettings.pitch = saved.pitch;
    campusAIVoiceSettings.volume = saved.volume;

    const rate =
        campusAI$("campusAiVoiceRate");

    const pitch =
        campusAI$("campusAiVoicePitch");

    const volume =
        campusAI$("campusAiVoiceVolume");

    if (rate) rate.value = saved.rate;
    if (pitch) pitch.value = saved.pitch;
    if (volume) volume.value = saved.volume;

    campusAIUpdateVoiceLabels();
    campusAISaveVoiceSettings();
}


/*
   Updates rate/pitch/volume for whichever voice is
   currently selected, and remembers it under that voice's
   own voiceURI so it doesn't leak onto other voices later.
*/
function campusAIUpdateVoiceOverride(field, rawValue) {

    const value = Number(rawValue);

    campusAIVoiceSettings[field] = value;

    const voiceURI =
        campusAIVoiceSettings.voiceURI ||
        campusAIGetSelectedVoice()?.voiceURI ||
        "";

    if (voiceURI) {

        const existing =
            campusAIVoiceSettings.voiceOverrides[
                voiceURI
            ] || { rate: 1, pitch: 1, volume: 1 };

        campusAIVoiceSettings.voiceOverrides[
            voiceURI
        ] = {
            ...existing,
            [field]: value
        };
    }

    campusAIUpdateVoiceLabels();
    campusAISaveVoiceSettings();
}


/* =========================================================
   29. SETTINGS
   ========================================================= */

function openCampusAISettings() {

    closeCampusAIMoreMenu();

    let modal =
        campusAI$("campusAiSettingsModal");

    if (!modal) {

        modal =
            document.createElement("div");

        modal.id =
            "campusAiSettingsModal";

        modal.className =
            "campus-ai-modal-backdrop";

        modal.innerHTML = `
            <div
                class="campus-ai-modal"
                role="dialog"
                aria-modal="true">

                <div class="campus-ai-modal-header">

                    <h3>AI Settings</h3>

                    <button
                        type="button"
                        class="campus-ai-modal-close"
                        onclick="closeCampusAISettings()">
                        ×
                    </button>

                </div>

                <div class="campus-ai-modal-body">

                    <div class="campus-ai-form-group">

                        <label for="campusAiVoiceSelect">
                            Voice
                        </label>

                        <select
                            id="campusAiVoiceSelect">
                        </select>

                    </div>

                    <div class="campus-ai-setting-row">

                        <label for="campusAiVoiceRate">
                            Speech rate
                        </label>

                        <div>
                            <input
                                id="campusAiVoiceRate"
                                type="range"
                                min="0.5"
                                max="2"
                                step="0.1">

                            <span
                                id="campusAiVoiceRateValue">
                            </span>
                        </div>

                    </div>

                    <div class="campus-ai-setting-row">

                        <label for="campusAiVoicePitch">
                            Pitch
                        </label>

                        <div>
                            <input
                                id="campusAiVoicePitch"
                                type="range"
                                min="0"
                                max="2"
                                step="0.1">

                            <span
                                id="campusAiVoicePitchValue">
                            </span>
                        </div>

                    </div>

                    <div class="campus-ai-setting-row">

                        <label for="campusAiVoiceVolume">
                            Volume
                        </label>

                        <div>
                            <input
                                id="campusAiVoiceVolume"
                                type="range"
                                min="0"
                                max="1"
                                step="0.1">

                            <span
                                id="campusAiVoiceVolumeValue">
                            </span>
                        </div>

                    </div>

                    <label class="campus-ai-checkbox">

                        <input
                            id="campusAiAutoRead"
                            type="checkbox">

                        <span>
                            Automatically read AI answers aloud
                        </span>

                    </label>

                    <div class="campus-ai-voice-actions">

                        <button
                            type="button"
                            class="campus-ai-primary-button"
                            onclick="testCampusAIVoice()">
                            🔊 Test Voice
                        </button>

                        <button
                            type="button"
                            class="campus-ai-secondary-button"
                            onclick="populateCampusAIVoices()">
                            ↻ Refresh Voices
                        </button>

                    </div>

                </div>
            </div>
        `;

        document.body.appendChild(
            modal
        );

        campusAIBindVoiceSettingsControls();
    }

    const rate =
        campusAI$("campusAiVoiceRate");

    const pitch =
        campusAI$("campusAiVoicePitch");

    const volume =
        campusAI$("campusAiVoiceVolume");

    const autoRead =
        campusAI$("campusAiAutoRead");

    if (rate) {
        rate.value =
            campusAIVoiceSettings.rate;
    }

    if (pitch) {
        pitch.value =
            campusAIVoiceSettings.pitch;
    }

    if (volume) {
        volume.value =
            campusAIVoiceSettings.volume;
    }

    if (autoRead) {
        autoRead.checked =
            campusAIVoiceSettings.autoRead;
    }

    campusAIUpdateVoiceLabels();
    populateCampusAIVoices();

    modal.classList.add("open");
}


function closeCampusAISettings() {

    const modal =
        campusAI$("campusAiSettingsModal");

    if (modal) {
        modal.classList.remove("open");
    }
}


function campusAIUpdateVoiceLabels() {

    const rateValue =
        campusAI$("campusAiVoiceRateValue");

    const pitchValue =
        campusAI$("campusAiVoicePitchValue");

    const volumeValue =
        campusAI$("campusAiVoiceVolumeValue");

    if (rateValue) {
        rateValue.textContent =
            Number(
                campusAIVoiceSettings.rate
            ).toFixed(1);
    }

    if (pitchValue) {
        pitchValue.textContent =
            Number(
                campusAIVoiceSettings.pitch
            ).toFixed(1);
    }

    if (volumeValue) {
        volumeValue.textContent =
            Number(
                campusAIVoiceSettings.volume
            ).toFixed(1);
    }
}


function testCampusAIVoice() {

    const text =
        "Hello. I am Kenyan Campus AI. Your voice settings are working correctly.";

    speakCampusAIText(text);
}


/* =========================================================
   30. ACCOUNT MODAL
   ========================================================= */

function openCampusAIAccount() {

    closeCampusAIMoreMenu();

    let modal =
        campusAI$("campusAiAccountModal");

    if (!modal) {

        modal =
            document.createElement("div");

        modal.id =
            "campusAiAccountModal";

        modal.className =
            "campus-ai-modal-backdrop";

        modal.innerHTML = `
            <div
                class="campus-ai-modal"
                role="dialog"
                aria-modal="true">

                <div class="campus-ai-modal-header">

                    <h3>Account</h3>

                    <button
                        type="button"
                        class="campus-ai-modal-close"
                        onclick="closeCampusAIAccount()">
                        ×
                    </button>

                </div>

                <div
                    id="campusAiAccountBody"
                    class="campus-ai-modal-body">
                </div>

            </div>
        `;

        document.body.appendChild(
            modal
        );
    }

    campusAIRenderAccountBody();

    modal.classList.add("open");
}


function closeCampusAIAccount() {

    const modal =
        campusAI$("campusAiAccountModal");

    if (modal) {
        modal.classList.remove("open");
    }
}


function campusAIRenderAccountBody() {

    const body =
        campusAI$("campusAiAccountBody");

    if (!body) return;

    const account =
        campusAIGetCurrentAccount();

    if (
        account.id !== "guest"
    ) {

        body.innerHTML = `
            <div class="campus-ai-account-profile">

                <div class="campus-ai-account-avatar">
                    ${campusAIEscapeHTML(
                        campusAIGetEmailInitials(
                            account.email
                        ) || "U"
                    )}
                </div>

                <h3>
                    ${campusAIEscapeHTML(
                        account.name
                    )}
                </h3>

                <p>
                    ${campusAIEscapeHTML(
                        account.email
                    )}
                </p>

                <div class="campus-ai-account-note">
                    Your conversations are saved
                    separately on this browser.
                </div>

                <button
                    type="button"
                    class="campus-ai-primary-button"
                    onclick="campusAILogout()">
                    Log out
                </button>

            </div>
        `;

        return;
    }

    body.innerHTML = `

        <div class="campus-ai-account-tabs">

            <button
                type="button"
                class="campus-ai-account-tab active"
                id="campusAiLoginTab"
                onclick="campusAISwitchAccountTab('login')">
                Login
            </button>

            <button
                type="button"
                class="campus-ai-account-tab"
                id="campusAiRegisterTab"
                onclick="campusAISwitchAccountTab('register')">
                Register
            </button>

        </div>

        <div id="campusAiLoginPanel">

            <form
                onsubmit="campusAILogin(event)">

                <div class="campus-ai-form-group">

                    <label>Email</label>

                    <input
                        id="campusAiLoginEmail"
                        type="email"
                        required
                        autocomplete="email"
                        placeholder="Enter your email">

                </div>

                <div class="campus-ai-form-group">

                    <label>Password</label>

                    <input
                        id="campusAiLoginPassword"
                        type="password"
                        required
                        autocomplete="current-password"
                        placeholder="Enter your password">

                </div>

                <div
                    id="campusAiLoginError"
                    class="campus-ai-account-note">
                </div>

                <button
                    type="submit"
                    class="campus-ai-primary-button">
                    Login
                </button>

                <button
                    type="button"
                    class="campus-ai-link-button"
                    onclick="campusAISwitchAccountTab('forgot')">
                    Forgot password?
                </button>

            </form>

        </div>

        <div
            id="campusAiForgotPanel"
            style="display:none;">

            <form
                onsubmit="campusAIResetPassword(event)">

                <div class="campus-ai-form-group">

                    <label>Email</label>

                    <input
                        id="campusAiForgotEmail"
                        type="email"
                        required
                        autocomplete="email"
                        placeholder="Enter your account email">

                </div>

                <div class="campus-ai-form-group">

                    <label>New password</label>

                    <input
                        id="campusAiForgotPassword"
                        type="password"
                        required
                        minlength="6"
                        autocomplete="new-password"
                        placeholder="At least 6 characters">

                </div>

                <div
                    id="campusAiForgotError"
                    class="campus-ai-account-note">
                </div>

                <button
                    type="submit"
                    class="campus-ai-primary-button">
                    Reset password
                </button>

                <button
                    type="button"
                    class="campus-ai-link-button"
                    onclick="campusAISwitchAccountTab('login')">
                    Back to login
                </button>

            </form>

        </div>

        <div
            id="campusAiRegisterPanel"
            style="display:none;">

            <form
                onsubmit="campusAIRegister(event)">

                <div class="campus-ai-form-group">

                    <label>Name</label>

                    <input
                        id="campusAiRegisterName"
                        type="text"
                        required
                        autocomplete="name"
                        placeholder="Your name">

                </div>

                <div class="campus-ai-form-group">

                    <label>Email</label>

                    <input
                        id="campusAiRegisterEmail"
                        type="email"
                        required
                        autocomplete="email"
                        placeholder="Your email">

                </div>

                <div class="campus-ai-form-group">

                    <label>Password</label>

                    <input
                        id="campusAiRegisterPassword"
                        type="password"
                        required
                        minlength="6"
                        autocomplete="new-password"
                        placeholder="At least 6 characters">

                </div>

                <div
                    id="campusAiRegisterError"
                    class="campus-ai-account-note">
                </div>

                <button
                    type="submit"
                    class="campus-ai-primary-button">
                    Create account
                </button>

            </form>

        </div>

        <div class="campus-ai-account-note">
            You can use Kenyan Campus AI as a guest.
            Accounts are stored locally on this browser.
        </div>
    `;
}


function campusAISwitchAccountTab(
    tab
) {

    const loginTab =
        campusAI$("campusAiLoginTab");

    const registerTab =
        campusAI$("campusAiRegisterTab");

    const loginPanel =
        campusAI$("campusAiLoginPanel");

    const registerPanel =
        campusAI$("campusAiRegisterPanel");

    const forgotPanel =
        campusAI$("campusAiForgotPanel");

    const panels = {
        login: loginPanel,
        register: registerPanel,
        forgot: forgotPanel
    };

    Object.values(panels).forEach(
        panel => {

            if (panel) {
                panel.style.display =
                    "none";
            }
        }
    );

    if (panels[tab]) {
        panels[tab].style.display =
            "block";
    }

    /*
       "Forgot password" is reached via a link,
       not a tab button, so it visually keeps
       the Login tab highlighted.
    */

    if (tab === "register") {

        loginTab?.classList.remove(
            "active"
        );

        registerTab?.classList.add(
            "active"
        );

    } else {

        registerTab?.classList.remove(
            "active"
        );

        loginTab?.classList.add(
            "active"
        );
    }
}


async function campusAIRegister(event) {

    event?.preventDefault();

    const name =
        campusAI$("campusAiRegisterName")
            ?.value
            .trim();

    const email =
        campusAI$("campusAiRegisterEmail")
            ?.value
            .trim()
            .toLowerCase();

    const password =
        campusAI$("campusAiRegisterPassword")
            ?.value || "";

    const error =
        campusAI$("campusAiRegisterError");

    if (error) {
        error.textContent = "";
    }

    if (
        !name ||
        !email ||
        password.length < 6
    ) {

        if (error) {
            error.textContent =
                "Please fill all fields. Password must be at least 6 characters.";
        }

        return;
    }

    const accounts =
        campusAILoadAccounts();

    if (
        accounts.some(
            account =>
                account.email === email
        )
    ) {

        if (error) {
            error.textContent =
                "An account with this email already exists.";
        }

        return;
    }

    const passwordHash =
        await campusAIHashPassword(
            password
        );

    const account = {

        id: campusAIUid("user"),

        name,

        email,

        passwordHash,

        createdAt:
            new Date().toISOString()
    };

    accounts.push(account);

    campusAISaveAccounts(accounts);

    localStorage.setItem(
        CAMPUS_AI_CURRENT_ACCOUNT_KEY,
        account.id
    );

    campusAILoadChats();

    campusAIRenderMessages();
    campusAIRenderHistory();

    campusAIUpdateAccountBadge();

    closeCampusAIAccount();

    campusAIUpdateSendState();
}


async function campusAILogin(event) {

    event?.preventDefault();

    const email =
        campusAI$("campusAiLoginEmail")
            ?.value
            .trim()
            .toLowerCase();

    const password =
        campusAI$("campusAiLoginPassword")
            ?.value || "";

    const error =
        campusAI$("campusAiLoginError");

    if (error) {
        error.textContent = "";
    }

    const accounts =
        campusAILoadAccounts();

    const account =
        accounts.find(
            item =>
                item.email === email
        );

    if (!account) {

        if (error) {
            error.textContent =
                "Invalid email or password.";
        }

        return;
    }

    const hash =
        await campusAIHashPassword(
            password
        );

    if (
        hash !== account.passwordHash
    ) {

        if (error) {
            error.textContent =
                "Invalid email or password.";
        }

        return;
    }

    localStorage.setItem(
        CAMPUS_AI_CURRENT_ACCOUNT_KEY,
        account.id
    );

    campusAILoadChats();

    campusAIRenderMessages();
    campusAIRenderHistory();

    campusAIUpdateAccountBadge();

    closeCampusAIAccount();

    campusAIUpdateSendState();
}


async function campusAIResetPassword(event) {

    event?.preventDefault();

    const email =
        campusAI$("campusAiForgotEmail")
            ?.value
            .trim()
            .toLowerCase();

    const newPassword =
        campusAI$("campusAiForgotPassword")
            ?.value || "";

    const error =
        campusAI$("campusAiForgotError");

    if (error) {
        error.textContent = "";
    }

    if (
        !email ||
        newPassword.length < 6
    ) {

        if (error) {
            error.textContent =
                "Enter your email and a new password of at least 6 characters.";
        }

        return;
    }

    const accounts =
        campusAILoadAccounts();

    const account =
        accounts.find(
            item =>
                item.email === email
        );

    if (!account) {

        if (error) {
            error.textContent =
                "No account exists with that email.";
        }

        return;
    }

    account.passwordHash =
        await campusAIHashPassword(
            newPassword
        );

    campusAISaveAccounts(accounts);

    if (error) {
        error.textContent =
            "Password reset. You can now log in.";

        error.classList.add(
            "campus-ai-account-note-success"
        );
    }

    setTimeout(() => {

        campusAISwitchAccountTab("login");

        const loginEmail =
            campusAI$("campusAiLoginEmail");

        if (loginEmail) {
            loginEmail.value = email;
        }

    }, 900);
}


function campusAILogout() {

    stopCampusAI();

    localStorage.removeItem(
        CAMPUS_AI_CURRENT_ACCOUNT_KEY
    );

    campusAIHistory = [];
    campusAICurrentChatId = null;
    campusAIActiveDocuments = [];
    campusAIUploadedDocuments = [];

    campusAIRenderMessages();
    campusAIRenderHistory();

    clearCampusAIFiles();

    campusAIUpdateAccountBadge();

    closeCampusAIAccount();

    campusAIUpdateSendState();
}


/* =========================================================
   31. MORE MENU
   ========================================================= */

function campusAIRenderAccountBadgeContent() {

    const account =
        campusAIGetCurrentAccount();

    if (account.id === "guest") {
        return "👤";
    }

    return (
        campusAIGetEmailInitials(
            account.email
        ) || "👤"
    );
}


function campusAIUpdateAccountBadge() {

    const button =
        campusAI$("campusAiMoreButton");

    if (!button) return;

    button.innerHTML =
        campusAIRenderAccountBadgeContent();
}


function campusAIEnsureMoreMenu() {

    /*
       Docked in the sidebar, fixed below the
       recent conversations list — not in the
       top toolbar anymore.
    */

    const dock =
        campusAI$("campusAiSidebar") ||
        document.querySelector(
            ".campus-ai-header-actions"
        );

    if (!dock) return;

    if (
        campusAI$("campusAiMoreButton")
    ) {
        campusAIUpdateAccountBadge();
        return;
    }

    const footer =
        document.createElement("div");

    footer.id =
        "campusAiSidebarFooter";

    footer.className =
        "campus-ai-sidebar-footer";

    const button =
        document.createElement("button");

    button.id =
        "campusAiMoreButton";

    button.type = "button";

    button.className =
        "campus-ai-more-button campus-ai-account-badge";

    button.title =
        "Account and more";

    button.setAttribute(
        "aria-label",
        "Account and more"
    );

    button.innerHTML =
        campusAIRenderAccountBadgeContent();

    footer.appendChild(button);

    dock.appendChild(footer);

    button.addEventListener(
        "click",
        toggleCampusAIMoreMenu
    );

    const menu =
        document.createElement("div");

    menu.id =
        "campusAiMoreMenu";

    menu.className =
        "campus-ai-more-menu campus-ai-more-menu-docked";

    menu.innerHTML = `

        <button
            type="button"
            class="campus-ai-more-item"
            onclick="openCampusAIHistoryFromMore()">

            <span class="campus-ai-more-item-icon">
                🕘
            </span>

            <span>
                Recent Conversations
            </span>

        </button>

        <button
            type="button"
            class="campus-ai-more-item"
            onclick="openCampusAIAccount()">

            <span class="campus-ai-more-item-icon">
                👤
            </span>

            <span>
                Account
            </span>

        </button>

        <button
            type="button"
            class="campus-ai-more-item"
            onclick="openCampusAISettings()">

            <span class="campus-ai-more-item-icon">
                ⚙️
            </span>

            <span>
                Settings
            </span>

        </button>

        <button
            type="button"
            class="campus-ai-more-item"
            onclick="openCampusAITalkPage(); closeCampusAIMoreMenu();">

            <span class="campus-ai-more-item-icon">
                🎙️
            </span>

            <span>
                Talk to AI
            </span>

        </button>
    `;

    footer.appendChild(menu);
}


function toggleCampusAIMoreMenu() {

    const menu =
        campusAI$("campusAiMoreMenu");

    if (!menu) return;

    menu.classList.toggle("open");
}


function closeCampusAIMoreMenu() {

    const menu =
        campusAI$("campusAiMoreMenu");

    if (menu) {
        menu.classList.remove("open");
    }
}


function openCampusAIHistoryFromMore() {

    closeCampusAIMoreMenu();

    const sidebar =
        campusAI$("campusAiSidebar");

    if (
        sidebar &&
        !sidebar.classList.contains("open")
    ) {
        toggleCampusAISidebar();
    }
}


document.addEventListener(
    "click",
    function (event) {

        const menu =
            campusAI$("campusAiMoreMenu");

        const button =
            campusAI$("campusAiMoreButton");

        if (!menu || !button) return;

        if (
            !menu.contains(event.target) &&
            !button.contains(event.target)
        ) {

            menu.classList.remove(
                "open"
            );
        }
    }
);


/* =========================================================
   32. SUGGESTIONS
   ========================================================= */

function campusAISuggestion(text) {

    const input =
        campusAI$("campusAiInput");

    if (!input) return;

    input.value = text;

    campusAIResizeInput();
    campusAIUpdateSendState();

    input.focus();
}


/* =========================================================
   33. FILE UPLOAD
   ========================================================= */

function handleCampusAIFileUpload(event) {

    const files =
        Array.from(
            event?.target?.files || []
        );

    if (!files.length) return;

    campusAIUploadedDocuments.push(
        ...files
    );

    campusAIRenderUploadedFiles();

    campusAIUpdateSendState();

    if (event.target) {
        event.target.value = "";
    }
}


function campusAIRenderUploadedFiles() {

    const container =
        campusAI$("campusAiFiles");

    if (!container) return;

    container.innerHTML = "";

    campusAIUploadedDocuments.forEach(
        (file, index) => {

            const item =
                document.createElement("div");

            item.className =
                "campus-ai-file";

            item.innerHTML = `
                <span>
                    📄
                    ${campusAIEscapeHTML(
                        file.name
                    )}
                </span>

                <button
                    type="button"
                    onclick="removeCampusAIFile(${index})"
                    title="Remove">
                    ×
                </button>
            `;

            container.appendChild(
                item
            );
        }
    );
}


function removeCampusAIFile(index) {

    campusAIUploadedDocuments.splice(
        index,
        1
    );

    campusAIRenderUploadedFiles();
    campusAIUpdateSendState();
}


function clearCampusAIFiles() {

    campusAIUploadedDocuments = [];

    campusAIRenderUploadedFiles();

    campusAIUpdateSendState();
}


function campusAIClearUploadedFiles() {
    clearCampusAIFiles();
}


/*
   Loads a third-party script from a CDN exactly once and
   caches the in-flight promise, so multiple uploads don't
   each try to inject the same <script> tag.
*/
const campusAIScriptLoadPromises = {};

function campusAILoadScript(src) {

    if (campusAIScriptLoadPromises[src]) {
        return campusAIScriptLoadPromises[src];
    }

    campusAIScriptLoadPromises[src] =
        new Promise((resolve, reject) => {

            const script =
                document.createElement("script");

            script.src = src;
            script.async = true;

            script.onload =
                () => resolve();

            script.onerror =
                () =>
                    reject(
                        new Error(
                            `Failed to load ${src}`
                        )
                    );

            document.head.appendChild(script);
        });

    return campusAIScriptLoadPromises[src];
}


/*
   Extracts the text of an uploaded PDF using pdf.js,
   loaded lazily from a CDN on first use.
*/
async function campusAIExtractPdfText(file) {

    await campusAILoadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
    );

    const pdfjsLib = window["pdfjs-dist/build/pdf"];

    if (!pdfjsLib) {
        throw new Error("pdf.js failed to load");
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    const buffer =
        await file.arrayBuffer();

    const pdf =
        await pdfjsLib.getDocument(
            { data: buffer }
        ).promise;

    const pageTexts = [];

    const maxPages =
        Math.min(pdf.numPages, 40);

    for (let i = 1; i <= maxPages; i++) {

        const page =
            await pdf.getPage(i);

        const content =
            await page.getTextContent();

        const pageText =
            content.items
                .map(item => item.str)
                .join(" ");

        pageTexts.push(pageText);
    }

    let text = pageTexts.join("\n\n");

    if (pdf.numPages > maxPages) {

        text +=
            `\n\n[Only the first ${maxPages} of ` +
            `${pdf.numPages} pages were read.]`;
    }

    return text;
}


/*
   Extracts the text of an uploaded Word document (.docx)
   using mammoth.js, loaded lazily from a CDN on first use.
   Old binary .doc files can't be parsed client-side; those
   are left for the backend / user to handle.
*/
async function campusAIExtractDocxText(file) {

    await campusAILoadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"
    );

    if (!window.mammoth) {
        throw new Error("mammoth.js failed to load");
    }

    const buffer =
        await file.arrayBuffer();

    const result =
        await window.mammoth.extractRawText(
            { arrayBuffer: buffer }
        );

    return result.value || "";
}


async function campusAIProcessUploadedFiles(
    files
) {

    const documents = [];

    for (const file of files) {

        const extension =
            file.name
                .split(".")
                .pop()
                ?.toLowerCase() || "";

        let text = "";

        try {

            if (
                ["txt", "csv", "json", "md"]
                    .includes(extension)
            ) {

                text =
                    await file.text();

            } else if (extension === "pdf") {

                text =
                    await campusAIExtractPdfText(
                        file
                    );

            } else if (extension === "docx") {

                text =
                    await campusAIExtractDocxText(
                        file
                    );
            }

        } catch (error) {

            console.warn(
                "Could not extract text from",
                file.name,
                error
            );

            text = "";
        }

        /*
           Cap how much text from one document gets sent to
           the backend. A very long PDF/Word doc can blow
           past the model's usable context, and when that
           happens answers tend to come back vague, cut off
           partway, or disorganized rather than erroring
           outright. Trimming with a clear note is safer
           than silently overflowing.
        */
        const CAMPUS_AI_MAX_DOC_CHARS = 24000;

        if (text.length > CAMPUS_AI_MAX_DOC_CHARS) {

            text =
                text.slice(
                    0,
                    CAMPUS_AI_MAX_DOC_CHARS
                ) +
                "\n\n[Document truncated - only the first " +
                `${CAMPUS_AI_MAX_DOC_CHARS} characters were included.]`;
        }

        documents.push({

            id:
                campusAIUid("doc"),

            name:
                file.name,

            type:
                file.type,

            size:
                file.size,

            extension,

            text,

            uploadedAt:
                new Date().toISOString()
        });
    }

    return documents;
}


function campusAILikelyQuestionDocument(
    documents
) {

    const text =
        documents
            .map(
                document =>
                    document.text || ""
            )
            .join("\n")
            .toLowerCase();

    if (!text) return false;

    const strongPatterns = [
        /\bquestion\s*\d+/,
        /\bq\s*\d+/,
        /\bsection\s+[a-z]/,
        /\banswer\s+(all|any|the)/,
        /\bsolve\b/,
        /\bcalculate\b/,
        /\bexamination\b/,
        /\bexam\s+paper\b/,
        /\btest\s+paper\b/
    ];

    const normalPatterns = [
        /\bmarks?\b/,
        /\bassignment\b/,
        /\bquiz\b/,
        /\bexercise\b/,
        /\bshow\s+working\b/,
        /\bdiscuss\b/,
        /\bcompute\b/
    ];

    const strong =
        strongPatterns.filter(
            pattern =>
                pattern.test(text)
        ).length;

    const normal =
        normalPatterns.filter(
            pattern =>
                pattern.test(text)
        ).length;

    return (
        strong >= 2 ||
        (strong >= 1 && normal >= 1)
    );
}


/* =========================================================
   34. CLEAR CHAT / HISTORY
   ========================================================= */

function clearCampusAI() {

    stopCampusAI();

    campusAIHistory = [];

    const chat =
        campusAIGetChat();

    if (chat) {

        chat.messages = [];
        chat.documents = [];

        chat.updatedAt =
            new Date().toISOString();

        campusAISaveChats();
    }

    campusAIActiveDocuments = [];

    campusAIRenderMessages();
    campusAIRenderHistory();

    campusAIUpdateSendState();
}


function clearAllCampusAIHistory() {

    const accountId =
        campusAIGetCurrentAccountId();

    const confirmed =
        window.confirm(
            "Clear all recent conversations for this account?"
        );

    if (!confirmed) return;

    campusAIChats =
        campusAIChats.filter(
            chat =>
                chat.accountId !==
                accountId
        );

    campusAISaveChats();

    campusAIHistory = [];
    campusAICurrentChatId = null;
    campusAIActiveDocuments = [];

    campusAIRenderMessages();
    campusAIRenderHistory();

    campusAIUpdateSendState();
}


/* =========================================================
   35. TALK PAGE
   ========================================================= */

function campusAIEnsureTalkPage() {

    if (
        campusAI$("campusAiTalkPage")
    ) {
        return;
    }

    const page =
        document.createElement("section");

    page.id =
        "campusAiTalkPage";

    page.className =
        "campus-ai-talk-page";

    page.innerHTML = `

        <div class="campus-ai-talk-header">

            <button
                type="button"
                class="campus-ai-talk-back"
                onclick="closeCampusAITalkPage()"
                aria-label="Back">
                ←
            </button>

            <div class="campus-ai-talk-name">
                Kenyan Campus AI
            </div>

        </div>

        <div class="campus-ai-talk-center">

            <button
                type="button"
                id="campusAiTalkMic"
                class="campus-ai-talk-mic"
                onclick="toggleCampusAITalkListening()"
                aria-label="Microphone">
                🎙️
            </button>

            <div
                id="campusAiTalkStatus"
                class="campus-ai-talk-status">
                Tap the mic to start talking
            </div>

        </div>

        <!--
            The actual conversation text still happens
            here in the background (same data/history
            as the main chat) so nothing is lost, but it
            is not shown on this voice screen — only the
            mic and status are visible, the same way a
            voice assistant works.
        -->

        <div
            id="campusAiTalkMessages"
            class="campus-ai-talk-messages"
            hidden>
        </div>

        <textarea
            id="campusAiTalkTranscript"
            class="campus-ai-talk-transcript"
            rows="1"
            placeholder="Speak your message..."
            onkeydown="handleCampusAITalkKey(event)"
            hidden>
        </textarea>

        <button
            type="button"
            class="campus-ai-talk-send"
            onclick="sendCampusAITalkMessage()"
            aria-label="Send"
            hidden>
            ➤
        </button>
    `;

    document.body.appendChild(page);
}


function openCampusAITalkPage() {

    campusAIEnsureTalkPage();

    const page =
        campusAI$("campusAiTalkPage");

    const main =
        campusAI$("campusAiPage");

    /*
       Completely hide normal chat.
    */

    if (main) {

        main.style.visibility =
            "hidden";

        main.style.pointerEvents =
            "none";

        main.setAttribute(
            "aria-hidden",
            "true"
        );
    }

    page.classList.add("open");

    document.body.classList.add(
        "campus-ai-talk-open"
    );

    document.body.style.overflow =
        "hidden";

    campusAITalkShouldListen = true;

    campusAITalkLastSubmitted = "";

    campusAIRenderTalkHistory();

    const transcript =
        campusAI$(
            "campusAiTalkTranscript"
        );

    if (transcript) {

        transcript.value = "";

        setTimeout(
            () => transcript.focus(),
            150
        );
    }

    setTimeout(
        () =>
            startCampusAITalkListening(),
        350
    );
}


function closeCampusAITalkPage() {

    campusAITalkShouldListen = false;

    stopCampusAITalkListening(false);

    campusAISpeechToken++;

    if (
        "speechSynthesis" in window
    ) {
        speechSynthesis.cancel();
    }

    campusAISpeaking = false;

    const page =
        campusAI$("campusAiTalkPage");

    if (page) {
        page.classList.remove("open");
    }

    const main =
        campusAI$("campusAiPage");

    if (main) {

        main.style.visibility =
            "";

        main.style.pointerEvents =
            "";

        main.removeAttribute(
            "aria-hidden"
        );
    }

    document.body.classList.remove(
        "campus-ai-talk-open"
    );

    document.body.style.overflow =
        "";
}


/* =========================================================
   36. TALK HISTORY
   ========================================================= */

function campusAIRenderTalkHistory() {

    const container =
        campusAI$("campusAiTalkMessages");

    if (!container) return;

    container.innerHTML = "";

    campusAIHistory
        .slice(-20)
        .forEach(message => {

            const item =
                document.createElement("div");

            item.className =
                `campus-ai-talk-message ${message.role}`;

            item.textContent =
                message.content;

            container.appendChild(
                item
            );
        });

    container.scrollTop =
        container.scrollHeight;
}


/* =========================================================
   37. TALK MICROPHONE
   ========================================================= */

function campusAIClearTalkSilenceTimer() {

    if (campusAITalkSilenceTimer) {

        clearTimeout(
            campusAITalkSilenceTimer
        );

        campusAITalkSilenceTimer = null;
    }
}


function startCampusAITalkListening() {

    if (!campusAIIsTalkOpen()) {
        return;
    }

    if (!campusAITalkShouldListen) {
        return;
    }

    if (campusAITalkProcessing) {
        return;
    }

    if (campusAISpeaking) {
        return;
    }

    if (
        campusAITalkListening
    ) {
        return;
    }

    const Recognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

    if (!Recognition) {

        campusAISetTalkStatus(
            "Speech recognition is not supported"
        );

        return;
    }

    if (
        campusAITalkRecognition
    ) {

        try {
            campusAITalkRecognition.abort();
        } catch {}
    }

    const recognition =
        new Recognition();

    campusAITalkRecognition =
        recognition;

    recognition.lang =
        "en-KE";

    recognition.continuous =
        true;

    recognition.interimResults =
        true;

    recognition.maxAlternatives =
        1;

    recognition.onstart = function () {

        campusAITalkListening =
            true;

        campusAIUpdateTalkMic();

        campusAISetTalkStatus(
            "Listening..."
        );
    };

    recognition.onresult =
        function (event) {

            let interim = "";
            let finalText = "";

            for (
                let i =
                    event.resultIndex;
                i <
                    event.results.length;
                i++
            ) {

                const result =
                    event.results[i];

                const transcript =
                    result[0].transcript;

                if (result.isFinal) {
                    finalText +=
                        transcript;
                } else {
                    interim +=
                        transcript;
                }
            }

            const textarea =
                campusAI$(
                    "campusAiTalkTranscript"
                );

            if (!textarea) return;

            /*
               Final speech stays in the input.
               It is NOT automatically sent.
            */

            if (finalText.trim()) {

                campusAITalkFinalTranscript +=
                    (
                        campusAITalkFinalTranscript
                            ? " "
                            : ""
                    ) +
                    finalText.trim();
            }

            textarea.value =
                (
                    campusAITalkFinalTranscript
                        ? campusAITalkFinalTranscript +
                          (
                              interim
                                  ? " " +
                                    interim
                                  : ""
                          )
                        : interim
                ).trim();

            textarea.style.height =
                "auto";

            textarea.style.height =
                Math.min(
                    textarea.scrollHeight,
                    160
                ) + "px";

            /*
               Silence-triggered auto-send:
               every time speech comes in, push
               the timer back. Once the user goes
               quiet for CAMPUS_AI_TALK_SILENCE_MS,
               and there is something said, send it
               automatically — no manual tap needed.
            */

            campusAIClearTalkSilenceTimer();

            if (
                campusAITalkFinalTranscript.trim() ||
                interim.trim()
            ) {

                campusAISetTalkStatus(
                    "Listening..."
                );

                campusAITalkSilenceTimer =
                    setTimeout(
                        () => {

                            campusAITalkSilenceTimer =
                                null;

                            if (
                                campusAITalkProcessing ||
                                campusAISpeaking
                            ) {
                                return;
                            }

                            /*
                               BUG FIX: some browsers'
                               continuous-mode speech
                               recognition can go the whole
                               time without ever marking a
                               result isFinal - the words
                               still SHOW in the box (interim
                               text), but
                               campusAITalkFinalTranscript
                               stays empty forever, so the
                               old check below
                               (`if campusAITalkFinalTranscript.trim()`)
                               never sent anything. That's
                               the "it listens but never
                               responds" symptom - looks
                               active, never actually submits.
                               Falling back to whatever is
                               currently in the box (final +
                               interim) means a genuine pause
                               in speech still gets sent even
                               when the browser never finalizes
                               it on its own.
                            */

                            if (
                                !campusAITalkFinalTranscript.trim() &&
                                interim.trim()
                            ) {

                                campusAITalkFinalTranscript =
                                    interim.trim();
                            }

                            if (
                                campusAITalkFinalTranscript.trim()
                            ) {

                                campusAISetTalkStatus(
                                    "Thinking..."
                                );

                                sendCampusAITalkMessage();
                            }
                        },
                        CAMPUS_AI_TALK_SILENCE_MS
                    );
            }
        };

    recognition.onerror =
        function (event) {

            console.warn(
                "Talk recognition:",
                event.error
            );

            campusAITalkListening =
                false;

            campusAIClearTalkSilenceTimer();

            campusAIUpdateTalkMic();

            if (
                event.error ===
                    "not-allowed" ||
                event.error ===
                    "service-not-allowed"
            ) {

                campusAITalkShouldListen =
                    false;

                campusAISetTalkStatus(
                    "Microphone permission denied"
                );

                return;
            }

            campusAISetTalkStatus(
                "Listening paused"
            );
        };

    recognition.onend =
        function () {

            campusAITalkListening =
                false;

            campusAIUpdateTalkMic();

            /*
               Restart recognition when it ends
               naturally, but NEVER send the text.
            */

            if (
                campusAITalkShouldListen &&
                campusAIIsTalkOpen() &&
                !campusAITalkProcessing &&
                !campusAISpeaking
            ) {

                setTimeout(
                    () =>
                        startCampusAITalkListening(),
                    150
                );
            }
        };

    try {

        recognition.start();

    } catch (error) {

        console.warn(
            "Could not start microphone:",
            error
        );
    }
}


function stopCampusAITalkListening(
    allowRestart = false
) {

    if (!allowRestart) {
        campusAITalkShouldListen =
            false;
    }

    campusAIClearTalkSilenceTimer();

    if (
        campusAITalkRecognition
    ) {

        try {
            campusAITalkRecognition.stop();
        } catch {

            try {
                campusAITalkRecognition.abort();
            } catch {}
        }
    }

    campusAITalkListening =
        false;

    campusAIUpdateTalkMic();
}


function interruptCampusAITalkSpeech() {

    /*
       BUG FIX: previously, tapping the mic while the AI was
       mid-sentence did nothing at all - toggleCampusAITalkListening()
       just flipped campusAITalkShouldListen to true, but
       startCampusAITalkListening() immediately bails out
       whenever campusAISpeaking is true. There was no way to
       cut the AI off; you had to wait for it to finish
       talking on its own. This explicitly stops all queued
       speech right now and restarts listening immediately,
       instead of waiting on speechSynthesis's onend/onerror
       events (which aren't reliably fired for every queued-
       but-not-yet-started sentence once cancel() is called).
    */

    if (!campusAISpeaking) return;

    if ("speechSynthesis" in window) {
        speechSynthesis.cancel();
    }

    campusAITalkSpeechQueueCount = 0;
    campusAISpeaking = false;
    campusAITalkShouldListen = true;

    campusAISetTalkStatus(
        "Listening..."
    );

    startCampusAITalkListening();
}


function toggleCampusAITalkListening() {

    if (campusAISpeaking) {
        interruptCampusAITalkSpeech();
        return;
    }

    if (campusAITalkListening) {

        campusAITalkShouldListen =
            false;

        stopCampusAITalkListening(
            false
        );

        campusAISetTalkStatus(
            "Microphone off"
        );

        return;
    }

    campusAITalkShouldListen =
        true;

    startCampusAITalkListening();
}


function campusAIUpdateTalkMic() {

    const mic =
        campusAI$("campusAiTalkMic");

    if (!mic) return;

    mic.classList.toggle(
        "listening",
        campusAITalkListening
    );
}


function campusAISetTalkStatus(
    status
) {

    const element =
        campusAI$("campusAiTalkStatus");

    if (element) {
        element.textContent =
            status;
    }
}


/* =========================================================
   38. TALK SEND
   ========================================================= */

function handleCampusAITalkKey(event) {

    if (
        event.key === "Enter" &&
        !event.shiftKey
    ) {

        event.preventDefault();

        sendCampusAITalkMessage();
    }
}


async function sendCampusAITalkMessage() {

    campusAIClearTalkSilenceTimer();

    if (
        campusAITalkProcessing
    ) {
        return;
    }

    const textarea =
        campusAI$("campusAiTalkTranscript");

    if (!textarea) return;

    const message =
        textarea.value.trim();

    if (!message) return;

    /*
       Prevent accidental duplicate sends.
    */

    if (
        message ===
        campusAITalkLastSubmitted
    ) {
        return;
    }

    campusAITalkLastSubmitted =
        message;

    campusAITalkProcessing =
        true;

    campusAITalkShouldListen =
        false;

    stopCampusAITalkListening(
        false
    );

    if (
        "speechSynthesis" in window
    ) {
        speechSynthesis.cancel();
    }

    campusAISetTalkStatus(
        "Thinking..."
    );

    campusAIAddTalkMessage(
        "user",
        message
    );

    textarea.value = "";

    campusAITalkFinalTranscript =
        "";

    textarea.style.height =
        "auto";

    const chat =
        createCampusAIChatIfNeeded();

    campusAIHistory.push({
        role: "user",
        content: message
    });

    chat.messages =
        [...campusAIHistory];

    campusAISaveChats();

    campusAITalkAbortController =
        new AbortController();

    let campusAITalkTimedOut = false;

    const talkTimeoutId = setTimeout(() => {

        campusAITalkTimedOut = true;
        campusAITalkAbortController?.abort();

    }, 60000);

    try {

        const response =
            await fetch(
                "/api/ai",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                        "Accept":
                            "text/event-stream, application/json, text/plain"
                    },

                    body: JSON.stringify({
                        message,
                        history:
                            campusAIHistory.slice(
                                0,
                                -1
                            ),
                        documents:
                            campusAIActiveDocuments
                    }),

                    signal:
                        campusAITalkAbortController
                            ?.signal
                }
            );

        clearTimeout(talkTimeoutId);

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        let spokenUpTo = 0;
        let statusSetToSpeaking = false;

        /*
           Speak completed sentences as they stream in,
           instead of waiting for the whole reply. This is
           the main thing that was making Talk mode feel
           slow to respond - previously nothing was said
           until generation had fully finished.
        */
        const reply =
            await campusAIReadFullResponse(
                response,
                text => {

                    const unspoken =
                        text.slice(spokenUpTo);

                    const sentenceMatch =
                        unspoken.match(
                            /^[\s\S]*?[.!?](?:\s|$)/
                        );

                    if (!sentenceMatch) return;

                    const sentence =
                        sentenceMatch[0];

                    spokenUpTo += sentence.length;

                    if (!statusSetToSpeaking) {
                        statusSetToSpeaking = true;
                        campusAISetTalkStatus(
                            "Speaking..."
                        );
                    }

                    campusAIQueueTalkSpeech(
                        sentence
                    );
                }
            );

        const finalReply =
            String(reply).trim();

        if (!finalReply) {
            throw new Error(
                "Empty AI response"
            );
        }

        // Speak whatever trailing text never hit
        // a sentence boundary (e.g. no closing period).
        const remainder =
            finalReply.slice(spokenUpTo).trim();

        if (remainder) {
            campusAIQueueTalkSpeech(remainder);
        }

        if (!statusSetToSpeaking) {
            campusAISetTalkStatus("Speaking...");
        }

        /*
           Exactly one assistant message.
        */

        campusAIAddTalkMessage(
            "assistant",
            finalReply
        );

        campusAIHistory.push({
            role: "assistant",
            content: finalReply
        });

        campusAIUpdateChatMetadata();

    } catch (error) {

        console.error(
            "Talk AI error:",
            error
        );

        const errorMessage =
            campusAITalkTimedOut
                ? "The AI server is taking too long to respond right now. Please try again."
                : "I could not connect to Kenyan Campus AI right now. Please check that your AI server is running.";

        campusAIAddTalkMessage(
            "assistant",
            errorMessage
        );

        campusAIHistory.push({
            role: "assistant",
            content: errorMessage
        });

        campusAIUpdateChatMetadata();

        campusAISetTalkStatus(
            "Ready"
        );

        campusAITalkShouldListen =
            true;

        setTimeout(
            () =>
                startCampusAITalkListening(),
            500
        );

    } finally {

        clearTimeout(talkTimeoutId);

        campusAITalkAbortController = null;

        campusAITalkProcessing =
            false;

        /*
           If speech synthesis is not available,
           restart microphone manually.
        */

        if (
            !("speechSynthesis" in window)
        ) {

            campusAITalkShouldListen =
                true;

            startCampusAITalkListening();
        }
    }
}


function campusAIAddTalkMessage(
    role,
    content
) {

    const container =
        campusAI$("campusAiTalkMessages");

    if (!container) return;

    const item =
        document.createElement("div");

    item.className =
        `campus-ai-talk-message ${role}`;

    item.textContent =
        content;

    container.appendChild(item);

    container.scrollTop =
        container.scrollHeight;
}


/* =========================================================
   39. TALK BUTTON ON RIGHT
   ========================================================= */

function campusAIEnsureVoiceTalkButton() {

    const toolbar =
        document.querySelector(
            ".campus-ai-toolbar-right"
        );

    if (!toolbar) return;

    if (
        campusAI$("campusAiTalkButton")
    ) {
        return;
    }

    const button =
        document.createElement("button");

    button.id =
        "campusAiTalkButton";

    button.type = "button";

    button.className =
        "campus-ai-talk-button";

    button.title =
        "Talk to AI";

    button.setAttribute(
        "aria-label",
        "Talk to AI"
    );

    button.innerHTML = `
        <span>🎙️</span>
        <span>Talk to AI</span>
    `;

    /*
       Put Talk on the RIGHT side,
       inside toolbar-right.
    */

    toolbar.appendChild(
        button
    );

    button.addEventListener(
        "click",
        openCampusAITalkPage
    );
}


/* =========================================================
   40. DOCUMENT SUMMARY COMPATIBILITY
   ========================================================= */

function sumarizeCampusAIConversation() {

    const chat =
        campusAIGetChat();

    if (chat) {
        campusAIGenerateSummary(chat);
    }
}


function summarizeCampusAIConversation() {

    const chat =
        campusAIGetChat();

    if (chat) {
        campusAIGenerateSummary(chat);
    }
}


/* =========================================================
   41. COMPATIBILITY ALIASES
   ========================================================= */

window.openCampusAI =
    openCampusAI;

window.closeCampusAI =
    closeCampusAI;

window.newCampusAIChat =
    newCampusAIChat;

window.sendCampusAI =
    sendCampusAI;

window.sendMessageToCampusAI =
    sendCampusAI;

window.stopCampusAI =
    stopCampusAI;

window.stopGeneratingCampusAI =
    stopCampusAI;

window.openKenyanCampusAI =
    openCampusAI;

window.closeKenyanCampusAI =
    closeCampusAI;

window.handleCampusAIKey =
    handleCampusAIKey;

window.handleCampusAIFileUpload =
    handleCampusAIFileUpload;

window.removeCampusAIFile =
    removeCampusAIFile;

window.clearCampusAIFiles =
    clearCampusAIFiles;

window.searchCampusAIChats =
    searchCampusAIChats;

window.loadCampusAIChat =
    loadCampusAIChat;

window.toggleCampusAISidebar =
    toggleCampusAISidebar;

window.closeCampusAISidebar =
    closeCampusAISidebar;

window.copyCampusAIAnswer =
    copyCampusAIAnswer;

window.copyCampusAICode =
    copyCampusAICode;

window.regenerateCampusAI =
    regenerateCampusAI;

window.rateCampusAIMessage =
    rateCampusAIMessage;

window.readCampusAIAnswer =
    readCampusAIAnswer;

window.campusAISuggestion =
    campusAISuggestion;

window.clearCampusAIInput =
    clearCampusAIInput;

window.openCampusAITalkPage =
    openCampusAITalkPage;

window.closeCampusAITalkPage =
    closeCampusAITalkPage;

window.toggleCampusAITalkListening =
    toggleCampusAITalkListening;

window.startCampusAITalkListening =
    startCampusAITalkListening;

window.stopCampusAITalkListening =
    stopCampusAITalkListening;

window.sendCampusAITalkMessage =
    sendCampusAITalkMessage;

window.handleCampusAITalkKey =
    handleCampusAITalkKey;

window.openCampusAISettings =
    openCampusAISettings;

window.closeCampusAISettings =
    closeCampusAISettings;

window.testCampusAIVoice =
    testCampusAIVoice;

window.openCampusAIAccount =
    openCampusAIAccount;

window.closeCampusAIAccount =
    closeCampusAIAccount;

window.campusAIRegister =
    campusAIRegister;

window.campusAILogin =
    campusAILogin;

window.campusAILogout =
    campusAILogout;

window.campusAIResetPassword =
    campusAIResetPassword;

window.campusAIUpdateAccountBadge =
    campusAIUpdateAccountBadge;

window.toggleCampusAIMoreMenu =
    toggleCampusAIMoreMenu;

window.clearCampusAI =
    clearCampusAI;

window.clearAllCampusAIHistory =
    clearAllCampusAIHistory;

window.sumarizeCampusAIConversation =
    sumarizeCampusAIConversation;

window.summarizeCampusAIConversation =
    summarizeCampusAIConversation;


/* =========================================================
   42. START
   ========================================================= */

if (
    document.readyState === "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializeCampusAI
    );

} else {

    initializeCampusAI();
}