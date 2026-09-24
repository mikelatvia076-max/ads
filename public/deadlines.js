/* =====================================================
   HigherSpace Connect — deadlines.js
   Powers the Deadlines Tracker page (deadlines.html).

   NOTE: DEADLINES below is sample/placeholder data so the
   page has something real to render. Replace it with a
   fetch() to your own data source (API, CMS, JSON file)
   whenever you have real, verified dates — and always
   double-check against the official portal before publishing.
===================================================== */

const DEADLINES = [
    {
        title: "HELB Second Semester Loan Application Window",
        category: "helb",
        date: "2026-10-10",
        link: "category.html?type=helb"
    },
    {
        title: "KUCCPS Second Revision of Choices",
        category: "kuccps",
        date: "2026-10-20",
        link: "category.html?type=kuccps"
    },
    {
        title: "Mastercard Foundation Scholars Program — New Intake",
        category: "scholarships",
        date: "2026-11-05",
        link: "category.html?type=scholarships"
    },
    {
        title: "Safaricom Graduate Trainee Program Applications",
        category: "jobs",
        date: "2026-10-31",
        link: "category.html?type=jobs"
    },
    {
        title: "HELB Undergraduate First-Time Applicants",
        category: "helb",
        date: "2026-12-01",
        link: "category.html?type=helb"
    },
    {
        title: "KCB Foundation Scholarship Closing Date",
        category: "scholarships",
        date: "2026-11-18",
        link: "category.html?type=scholarships"
    }
];

const CATEGORY_LABELS = {
    helb: "HELB",
    kuccps: "KUCCPS",
    scholarships: "Scholarships",
    jobs: "Jobs"
};

function daysUntil(dateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const target = new Date(dateStr + "T00:00:00");
    const msPerDay = 24 * 60 * 60 * 1000;

    return Math.round((target - today) / msPerDay);
}

function formatDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-KE", {
        day: "numeric",
        month: "long",
        year: "numeric"
    });
}

function daysBadge(days) {
    if (days < 0) return { text: "Closed", cls: "closed" };
    if (days === 0) return { text: "Today", cls: "urgent" };
    if (days <= 7) return { text: days + " days left", cls: "urgent" };
    if (days <= 30) return { text: days + " days left", cls: "soon" };
    return { text: days + " days left", cls: "later" };
}

function renderDeadlines(filter) {
    const list = document.getElementById("deadlinesList");
    if (!list) return;

    const items = DEADLINES
        .filter(function (item) {
            return filter === "all" || item.category === filter;
        })
        .sort(function (a, b) {
            return new Date(a.date) - new Date(b.date);
        });

    if (!items.length) {
        list.innerHTML = '<p class="deadlines-empty">No deadlines in this category right now.</p>';
        return;
    }

    list.innerHTML = items.map(function (item) {
        const days = daysUntil(item.date);
        const badge = daysBadge(days);

        return (
            '<a class="deadline-card cat-' + item.category + '" href="' + item.link + '">' +
                '<div class="deadline-main">' +
                    '<span class="deadline-tag">' + CATEGORY_LABELS[item.category] + '</span>' +
                    '<h3>' + item.title + '</h3>' +
                    '<p>' + formatDate(item.date) + '</p>' +
                '</div>' +
                '<span class="deadline-days ' + badge.cls + '">' + badge.text + '</span>' +
            '</a>'
        );
    }).join("");
}

document.addEventListener("DOMContentLoaded", function () {
    if (!document.getElementById("deadlinesList")) return; // not on this page

    renderDeadlines("all");

    const filterBar = document.getElementById("deadlinesFilter");
    if (!filterBar) return;

    filterBar.addEventListener("click", function (e) {
        const btn = e.target.closest("button[data-filter]");
        if (!btn) return;

        filterBar.querySelectorAll("button").forEach(function (b) {
            b.classList.remove("active");
        });
        btn.classList.add("active");

        renderDeadlines(btn.dataset.filter);
    });
});