/* Shared helpers for the decorated article + category pages */
"use strict";

function HS_catKey(category) {
    return String(category || "").trim().toLowerCase().replace(/\s+/g, "-");
}

/* Maps a category label to the ?type= value category.html understands */
function HS_catType(category) {
    const key = HS_catKey(category);
    return key === "university-rumours" ? "rumours" : key;
}

function HS_deadlineInfo(raw) {
    if (!raw || raw === "null") return null;
    const text = String(raw);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text + "T00:00:00") : new Date(text);
    if (Number.isNaN(d.getTime())) return null;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 864e5);

    let label, level;
    if (diff < 0) { label = "Closed"; level = "closed"; }
    else if (diff === 0) { label = "Closes today"; level = "soon"; }
    else if (diff === 1) { label = "Closes tomorrow"; level = "soon"; }
    else if (diff <= 7) { label = `${diff} days left`; level = "soon"; }
    else { label = `${diff} days left`; level = "open"; }

    return { date: d, label, level };
}