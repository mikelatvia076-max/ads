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
=========================================================
POPULAR COURSES

Unlike every other category on this page, "courses" has no
live backend source -- the AI content updater only ever
writes University Alerts / HELB / KUCCPS / Scholarships /
Jobs into articles.json, so /api/content/courses would
always return []. This is a small curated dataset instead,
keyed by the same course slugs the homepage's course chips
use (see COURSES_DATA in app.js).
=========================================================
*/

// Institutions reused across multiple courses below. URLs match
// the same official sites already used elsewhere on the site
// (see INSTITUTION_OFFICIAL_SITES in app.js).
const COURSE_INSTITUTIONS = {
    uon: { name: "University of Nairobi", url: "https://www.uonbi.ac.ke" },
    ku: { name: "Kenyatta University", url: "https://www.ku.ac.ke" },
    jkuat: { name: "JKUAT", url: "https://www.jkuat.ac.ke" },
    moi: { name: "Moi University", url: "https://www.mu.ac.ke" },
    strathmore: { name: "Strathmore University", url: "https://www.strathmore.edu" },
    egerton: { name: "Egerton University", url: "https://www.egerton.ac.ke" },
    "maseno-university": { name: "Maseno University", url: "https://www.maseno.ac.ke" },
    "technical-university-of-kenya": { name: "Technical University of Kenya", url: "https://www.tukenya.ac.ke" },
    "multimedia-university-of-kenya": { name: "Multimedia University of Kenya", url: "https://www.mmu.ac.ke" },
    "dedan-kimathi-university-of-technology": { name: "Dedan Kimathi University of Technology", url: "https://www.dkut.ac.ke" },
    "chuka-university": { name: "Chuka University", url: "https://www.chuka.ac.ke" },
    "mount-kenya-university": { name: "Mount Kenya University", url: "https://www.mku.ac.ke" },
    "catholic-university-of-eastern-africa": { name: "Catholic University of Eastern Africa", url: "https://www.cuea.edu" },
    "united-states-international-university-africa": { name: "United States International University Africa", url: "https://www.usiu.ac.ke" },
    "daystar-university": { name: "Daystar University", url: "https://www.daystar.ac.ke" },
    "africa-nazarene-university": { name: "Africa Nazarene University", url: "https://www.anu.ac.ke" },
    "zetech-university": { name: "Zetech University", url: "https://www.zetech.ac.ke" },
    "jaramogi-oginga-odinga-university-of-science-and-technology": { name: "Jaramogi Oginga Odinga University of Science and Technology", url: "https://www.jooust.ac.ke" },
    "masinde-muliro-university-of-science-and-technology": { name: "Masinde Muliro University of Science and Technology", url: "https://www.mmust.ac.ke" }
};

// National polytechnics - confirmed accredited, multi-department TVET
// institutions (each genuinely runs programmes across engineering,
// ICT, business, applied/health sciences, hospitality and more), so
// the same handful is reused across most fields below, the same way
// COURSE_INSTITUTIONS reuses UoN/JKUAT/etc. across many university
// courses.
const TVET_INSTITUTIONS = {
    "kabete-national-polytechnic": { name: "Kabete National Polytechnic", url: "https://kabetepoly.ac.ke" },
    "sigalagala-national-polytechnic": { name: "Sigalagala National Polytechnic", url: "https://www.sigalagalapoly.ac.ke" },
    "kisumu-national-polytechnic": { name: "Kisumu National Polytechnic", url: "https://www.kisumupoly.ac.ke" },
    "eldoret-national-polytechnic": { name: "The Eldoret National Polytechnic", url: "https://www.tenp.ac.ke" },
    "kenya-coast-national-polytechnic": { name: "Kenya Coast National Polytechnic", url: "https://kenyacoastpoly.ac.ke" }
};

// Specialised public colleges with a clear, verified match to a
// specific field - listed only where that match is real, rather
// than padding every course with an unrelated college.
const COLLEGE_INSTITUTIONS = {
    kmtc: { name: "Kenya Medical Training College (KMTC)", url: "https://www.kmtc.ac.ke" },
    "kenya-utalii-college": { name: "Kenya Utalii College", url: "https://utalii.ac.ke" },
    kimc: { name: "Kenya Institute of Mass Communication (KIMC)", url: "https://kimc.ac.ke" },
    kim: { name: "Kenya Institute of Management (KIM)", url: "https://kim.ac.ke" }
};

// Generic, level-wide admission notes (not course-specific cut-off
// points, which shift every KUCCPS placement cycle - these reflect
// the entry bands KUCCPS itself has repeatedly confirmed: C+ for
// degree programmes, C- for Diploma, D for Craft Certificate).
const COURSE_LEVEL_META = {
    university: {
        label: "University",
        icon: "🎓",
        criteria:
            "Placed through KUCCPS. Degree programmes generally need a KCSE mean grade of C+ (plus) or better, " +
            "plus the specific subject cluster points KUCCPS sets for this course. Cut-off points move every " +
            "placement cycle, so confirm this year's exact figure on the KUCCPS portal."
    },
    tvet: {
        label: "TVET Institution",
        icon: "🛠️",
        criteria:
            "National polytechnics take Diploma applicants with a KCSE mean grade of C- (minus) or better " +
            "(Craft Certificate: D plain, Artisan: D- and below), applied for through KUCCPS or directly with " +
            "the institution."
    },
    college: {
        label: "College",
        icon: "🏫",
        criteria:
            "Specialised colleges generally follow the same bands as TVET institutions - C- and above for " +
            "Diploma, D for Craft Certificate - though a handful of professional programmes set their own " +
            "entry requirements. Confirm directly with the college."
    }
};

const COURSE_INFO = {
    "computer-science": {
        label: "Computer Science", icon: "💻", duration: "Usually 4 years",
        blurb: "Focuses on programming, algorithms, software development, databases and the theory behind how computers work.",
        institutions: ["uon", "jkuat", "strathmore", "technical-university-of-kenya", "multimedia-university-of-kenya"],
        tvetInstitutions: ["kabete-national-polytechnic", "kenya-coast-national-polytechnic", "sigalagala-national-polytechnic"],
        collegeNote: "We don't have a specialised college pick for this - most Computing diploma routes run through the TVET institutions above."
    },
    "cybersecurity": {
        label: "Cybersecurity", icon: "🔐", duration: "Usually 4 years",
        blurb: "Covers network security, ethical hacking, digital forensics and protecting systems and data from cyber threats.",
        institutions: ["jkuat", "strathmore", "multimedia-university-of-kenya", "technical-university-of-kenya"],
        tvetInstitutions: ["kabete-national-polytechnic", "kenya-coast-national-polytechnic"],
        collegeNote: "Cybersecurity is mostly a degree/short-course specialisation in Kenya; at Diploma level, look for it under a general Computing/ICT programme at the TVET institutions above."
    },
    "business": {
        label: "Business", icon: "📊", duration: "Usually 4 years",
        blurb: "A broad foundation in management, marketing, accounting and entrepreneurship.",
        institutions: ["uon", "ku", "strathmore", "egerton", "maseno-university"],
        tvetInstitutions: ["kabete-national-polytechnic", "sigalagala-national-polytechnic", "kisumu-national-polytechnic", "eldoret-national-polytechnic", "kenya-coast-national-polytechnic"],
        collegeInstitutions: ["kim"]
    },
    "nursing": {
        label: "Nursing", icon: "🩺", duration: "Typically 4 years",
        blurb: "Trains students in patient care, clinical procedures, public health and healthcare management.",
        institutions: ["uon", "ku", "moi", "mount-kenya-university"],
        tvetNote: "Nursing diploma training in Kenya runs mainly through KMTC (see College) rather than the national polytechnics.",
        collegeInstitutions: ["kmtc"]
    },
    "engineering": {
        label: "Engineering", icon: "⚙️", duration: "Typically 5 years",
        blurb: "Covers the design, analysis and maintenance of structures, machines, electrical systems or processes.",
        institutions: ["uon", "jkuat", "technical-university-of-kenya", "moi", "egerton"],
        tvetInstitutions: ["kabete-national-polytechnic", "sigalagala-national-polytechnic", "kisumu-national-polytechnic", "eldoret-national-polytechnic", "kenya-coast-national-polytechnic"],
        collegeNote: "Engineering diploma/craft training in Kenya is a TVET-institution specialism - see the polytechnics above."
    },
    "education": {
        label: "Education", icon: "🍎", duration: "Usually 4 years",
        blurb: "Prepares students to teach, covering pedagogy, curriculum development and a chosen teaching subject.",
        institutions: ["ku", "moi", "egerton", "mount-kenya-university", "masinde-muliro-university-of-science-and-technology"],
        tvetNote: "Teacher training below degree level runs through dedicated Teacher Training Colleges (TTCs), a separate KUCCPS category from the national polytechnics listed for other courses on this page - check the KUCCPS TTC list for one near you.",
        collegeNote: "As above - Primary/ECDE teaching diplomas and certificates are a TTC specialism, not a general college one."
    },
    "law": {
        label: "Law", icon: "⚖️", duration: "Usually 4 years, plus the Kenya School of Law diploma before admission to the bar",
        blurb: "Covers legal theory, the Kenyan legal system, contracts, criminal law and litigation, leading to the LLB.",
        institutions: ["uon", "moi", "ku", "strathmore", "catholic-university-of-eastern-africa"],
        tvetNote: "Practising law in Kenya requires the LLB degree (then the Kenya School of Law's Advocates Training Programme) - there's no TVET diploma route into the profession itself.",
        collegeNote: "Some colleges offer a general Certificate/Diploma in Law or Paralegal Studies, but it doesn't lead to practising as an advocate - confirm exactly what a programme qualifies you for before enrolling."
    },
    "medicine": {
        label: "Medicine & Surgery", icon: "🩻", duration: "Typically 5-6 years, plus a mandatory internship",
        blurb: "Trains doctors to diagnose and treat illness, covering anatomy, physiology, pharmacology and clinical practice.",
        institutions: ["uon", "moi", "ku", "egerton", "mount-kenya-university"],
        tvetNote: "Becoming a doctor (MBChB) is a university-only pathway in Kenya - there's no TVET route into it.",
        collegeInstitutions: ["kmtc"],
        collegeNote: "KMTC's Diploma in Clinical Medicine trains Clinical Officers, a related but different, shorter qualification - not equivalent to the MBChB degree."
    },
    "information-technology": {
        label: "Information Technology", icon: "🖥️", duration: "Usually 4 years",
        blurb: "Focuses on applying computing to business and organizational needs — networks, systems support and IT infrastructure.",
        institutions: ["strathmore", "jkuat", "zetech-university", "united-states-international-university-africa"],
        tvetInstitutions: ["kabete-national-polytechnic", "kenya-coast-national-polytechnic", "sigalagala-national-polytechnic"],
        collegeNote: "We don't have a specialised college pick for this - most IT diploma routes run through the TVET institutions above."
    },
    "software-engineering": {
        label: "Software Engineering", icon: "🧑\u200d💻", duration: "Usually 4 years",
        blurb: "A more structured, engineering-focused approach to building, testing and maintaining large software systems.",
        institutions: ["strathmore", "jkuat", "multimedia-university-of-kenya", "dedan-kimathi-university-of-technology"],
        tvetInstitutions: ["kabete-national-polytechnic", "kenya-coast-national-polytechnic", "sigalagala-national-polytechnic"],
        collegeNote: "We don't have a specialised college pick for this - look for it under Computing/Software Development Diploma at the TVET institutions above."
    },
    "data-science": {
        label: "Data Science", icon: "📈", duration: "Usually 4 years",
        blurb: "Combines statistics, programming and machine learning to find patterns and insight in data.",
        institutions: ["strathmore", "jkuat", "uon"],
        tvetNote: "Data Science as a named diploma is rare in Kenya; a general Computing/ICT Diploma at a national polytechnic is the closest sub-degree route.",
        tvetInstitutions: ["kabete-national-polytechnic", "sigalagala-national-polytechnic"]
    },
    "actuarial-science": {
        label: "Actuarial Science", icon: "🧮", duration: "Usually 4 years",
        blurb: "Applies mathematics, statistics and financial theory to assess and manage risk, mainly in insurance and finance.",
        institutions: ["uon", "jkuat", "strathmore", "catholic-university-of-eastern-africa"],
        tvetNote: "Actuarial Science is university-only in Kenya - there's no TVET diploma route.",
        collegeNote: "A Diploma in Insurance covers related, adjacent ground, but isn't the same qualification as a degree in Actuarial Science."
    },
    "economics": {
        label: "Economics", icon: "💹", duration: "Usually 4 years",
        blurb: "Studies how markets, resources and policy decisions affect production, trade and wellbeing.",
        institutions: ["uon", "ku", "maseno-university", "egerton"],
        tvetInstitutions: ["kabete-national-polytechnic", "sigalagala-national-polytechnic"],
        collegeInstitutions: ["kim"]
    },
    "accounting-finance": {
        label: "Accounting & Finance", icon: "💰", duration: "Usually 4 years",
        blurb: "Covers financial reporting, auditing, taxation and corporate finance.",
        institutions: ["uon", "ku", "strathmore", "maseno-university", "egerton"],
        tvetInstitutions: ["kabete-national-polytechnic", "sigalagala-national-polytechnic", "kisumu-national-polytechnic", "eldoret-national-polytechnic", "kenya-coast-national-polytechnic"],
        collegeInstitutions: ["kim"]
    },
    "pharmacy": {
        label: "Pharmacy", icon: "💊", duration: "Typically 5 years",
        blurb: "Trains students in drug formulation, dispensing, pharmacology and counselling patients on medication.",
        institutions: ["uon", "ku", "jkuat", "mount-kenya-university"],
        tvetNote: "Pharmacy diploma training in Kenya runs mainly through KMTC (see College) rather than the national polytechnics.",
        collegeInstitutions: ["kmtc"],
        collegeNote: "KMTC's Diploma in Pharmaceutical Technology trains Pharmaceutical Technologists - a related but different, shorter qualification than the Bachelor of Pharmacy degree."
    },
    "agriculture": {
        label: "Agriculture", icon: "🌾", duration: "Usually 4 years",
        blurb: "Covers crop and livestock production, agribusiness, soil science and food security.",
        institutions: ["egerton", "uon", "jkuat", "chuka-university"],
        tvetInstitutions: ["kabete-national-polytechnic", "kisumu-national-polytechnic"]
    },
    "architecture": {
        label: "Architecture", icon: "🏛️", duration: "Typically 5 years or more, often followed by professional registration",
        blurb: "Focuses on designing buildings and spaces, blending creativity with structural and technical knowledge.",
        institutions: ["uon", "jkuat", "technical-university-of-kenya"],
        tvetInstitutions: ["kabete-national-polytechnic", "kenya-coast-national-polytechnic"],
        collegeNote: "Look for a Diploma in Building Technology or Architectural Draughtsmanship at the TVET institutions above - full professional registration as an architect still needs the degree."
    },
    "journalism": {
        label: "Journalism & Mass Communication", icon: "📰", duration: "Usually 4 years",
        blurb: "Covers news writing, media production, public relations and digital communication.",
        institutions: ["uon", "moi", "daystar-university", "ku"],
        tvetNote: "The clearest sub-degree route into media is KIMC's own Diploma/Certificate programmes (see College) rather than a general polytechnic.",
        collegeInstitutions: ["kimc"]
    },
    "psychology": {
        label: "Psychology", icon: "🧠", duration: "Usually 4 years",
        blurb: "Studies human behaviour, mental processes and emotional wellbeing.",
        institutions: ["uon", "ku", "daystar-university", "africa-nazarene-university"],
        tvetNote: "Psychology is largely a university-only field in Kenya - the closest sub-degree option is a Certificate/Diploma in Counselling, offered by various colleges rather than the national polytechnics.",
        collegeNote: "Look for a Diploma in Counselling Psychology at a Kenya-accredited college - it's a related but different, shorter qualification than a Psychology degree."
    },
    "hospitality-tourism": {
        label: "Hospitality & Tourism Management", icon: "🏨", duration: "Usually 4 years",
        blurb: "Prepares students to manage hotels, travel operations and tourism experiences.",
        institutions: ["ku", "maseno-university", "technical-university-of-kenya"],
        tvetInstitutions: ["kabete-national-polytechnic", "kenya-coast-national-polytechnic"],
        collegeInstitutions: ["kenya-utalii-college"]
    },
    "environmental-science": {
        label: "Environmental Science", icon: "🌍", duration: "Usually 4 years",
        blurb: "Studies ecosystems, pollution, conservation and sustainable resource management.",
        institutions: ["ku", "egerton", "jkuat", "jaramogi-oginga-odinga-university-of-science-and-technology"],
        tvetInstitutions: ["kabete-national-polytechnic"]
    },
    "public-health": {
        label: "Public Health", icon: "🏥", duration: "Usually 4 years",
        blurb: "Focuses on disease prevention, health promotion and community health systems.",
        institutions: ["uon", "moi", "ku", "mount-kenya-university"],
        tvetNote: "Public Health diploma training in Kenya runs mainly through KMTC (see College) rather than the national polytechnics.",
        collegeInstitutions: ["kmtc"]
    },
    "human-resource-management": {
        label: "Human Resource Management", icon: "🤝", duration: "Usually 4 years",
        blurb: "Covers recruitment, employee relations, training and organizational development.",
        institutions: ["uon", "ku", "strathmore", "jkuat"],
        tvetInstitutions: ["kabete-national-polytechnic", "sigalagala-national-polytechnic"],
        collegeInstitutions: ["kim"]
    },
    "veterinary-medicine": {
        label: "Veterinary Medicine", icon: "🐾", duration: "Typically 5 years",
        blurb: "Trains veterinarians in animal health, disease diagnosis, surgery and livestock production. The University of Nairobi runs Kenya's original veterinary faculty.",
        institutions: ["uon", "egerton"],
        tvetNote: "Becoming a vet (BVM) is a university-only pathway in Kenya. A separate Diploma in Animal Health & Production exists at some agricultural training institutes, but it's a different, shorter qualification (Animal Health Technician) - confirm with KUCCPS/the institution before assuming it leads to the same career.",
        collegeNote: "Same distinction as TVET - a related certificate/diploma pathway exists, but it doesn't make you a veterinary surgeon."
    }
};

function getFieldFromURL() {
    return String(getQueryParams().get("field") || "").trim().toLowerCase();
}

// Defaults to "university" - both so a bookmarked/old link that has
// no ?level= at all still works exactly as it always has, and so an
// unrecognised value doesn't quietly break the page.
function getLevelFromURL() {
    const requested = String(getQueryParams().get("level") || "").trim().toLowerCase();
    return COURSE_LEVEL_META[requested] ? requested : "university";
}

// Which institution dictionary, course field and fallback note apply
// for a given level - keeps renderCourseCategory() below from having
// to repeat this three times.
function getCourseLevelData(course, level) {
    if (level === "tvet") {
        return {
            institutionDict: TVET_INSTITUTIONS,
            keys: course.tvetInstitutions || [],
            note: course.tvetNote || null
        };
    }

    if (level === "college") {
        return {
            institutionDict: COLLEGE_INSTITUTIONS,
            keys: course.collegeInstitutions || [],
            note: course.collegeNote || null
        };
    }

    return {
        institutionDict: COURSE_INSTITUTIONS,
        keys: course.institutions || [],
        note: null
    };
}

function renderCourseCategory(field, level) {
    const container = $("articlesList");
    const course = COURSE_INFO[field];

    if (!container) return;

    if (!course) {
        container.innerHTML = `
            <div class="calculator-result">
                <h3>Course not found</h3>
                <p>We don't have information on that course yet.</p>
            </div>
        `;
        const count = $("resultCount");
        if (count) count.textContent = "";
        return;
    }

    const activeLevel = COURSE_LEVEL_META[level] ? level : "university";
    const levelMeta = COURSE_LEVEL_META[activeLevel];
    const levelData = getCourseLevelData(course, activeLevel);

    const cards = levelData.keys.map(function (key) {
        const inst = levelData.institutionDict[key];
        if (!inst) return "";

        return `
            <article class="article" data-cat="courses">
                <a class="card-link" href="${escapeHTML(inst.url)}" target="_blank" rel="noopener noreferrer">
                    <div class="article-content">
                        <div class="card-top">
                            <span class="article-category">${escapeHTML(levelMeta.label)}</span>
                        </div>
                        <h3>${escapeHTML(inst.name)}</h3>
                        <p class="card-summary">Offers ${escapeHTML(course.label)}. Visit the official site for admission requirements and how to apply.</p>
                        <div class="card-foot">
                            <span></span>
                            <span class="card-cta">Visit official site ↗</span>
                        </div>
                    </div>
                </a>
            </article>
        `;
    }).join("");

    const count = $("resultCount");
    if (count) {
        count.textContent = levelData.keys.length
            ? `${levelData.keys.length} institution${levelData.keys.length === 1 ? "" : "s"}`
            : "";
    }

    // Level switcher - lets a student flip between University / TVET /
    // College for the SAME course without going back to the homepage
    // modal, since the field is already in the URL.
    const switcherTabs = Object.keys(COURSE_LEVEL_META).map(function (key) {
        const meta = COURSE_LEVEL_META[key];
        const isActive = key === activeLevel;

        return `
            <a
                class="deadline-chip${isActive ? " is-safe" : ""}"
                href="category.html?type=courses&field=${encodeURIComponent(field)}&level=${encodeURIComponent(key)}"
                aria-current="${isActive ? "page" : "false"}"
            >${meta.icon} ${escapeHTML(meta.label)}</a>
        `;
    }).join("");

    // No curated institutions for this level - either because the
    // field genuinely has no such pathway (courseLevel.note explains
    // why), or because we just haven't curated one yet.
    const emptyState = levelData.keys.length ? "" : `
        <div class="calculator-result" style="text-align:left;">
            <p>${levelData.note ? escapeHTML(levelData.note) : `We don't have specific ${escapeHTML(levelMeta.label)} picks for ${escapeHTML(course.label)} yet.`}</p>
            <p>
                Search accredited institutions on
                <a href="https://www.tveta.go.ke" target="_blank" rel="noopener noreferrer">TVETA's own site</a>
                or check current placement options on the
                <a href="https://students.kuccps.net" target="_blank" rel="noopener noreferrer">KUCCPS portal</a>.
            </p>
        </div>
    `;

    container.innerHTML = `
        <div class="calculator-result" style="text-align:left;">
            <h3>${course.icon} ${escapeHTML(course.label)}</h3>
            <p>${escapeHTML(course.blurb)}</p>
            <p><strong>Typical duration:</strong> ${escapeHTML(course.duration)}</p>
        </div>
        <div class="course-level-switcher" style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;">${switcherTabs}</div>
        <div class="calculator-result" style="text-align:left;">
            <p><strong>${levelMeta.icon} ${escapeHTML(levelMeta.label)} admission criteria:</strong> ${escapeHTML(levelMeta.criteria)}</p>
        </div>
        ${emptyState}
        <div class="articles">${cards}</div>
    `;
}

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
    } else if (category === "courses") {
        const course = COURSE_INFO[getFieldFromURL()];
        const levelLabel = COURSE_LEVEL_META[getLevelFromURL()].label;
        pageTitle = course ? `Where to Study: ${course.label} (${levelLabel})` : "Popular Courses";
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

        } else if (category === "courses") {

            renderCourseCategory(getFieldFromURL(), getLevelFromURL());
            return;

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