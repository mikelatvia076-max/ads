import "dotenv/config";

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

console.log("GEMINI_API_KEY present:", Boolean(key));
console.log("GEMINI_MODEL in use:", model);

if (!key) {
    console.log("No GEMINI_API_KEY found in .env - stopping here.");
    process.exit(1);
}

console.log("\n--- Checking available models on your account ---");

// Uses Gemini's OpenAI-compatible endpoint (same one ai-updater.js
// uses), so this lists models the same way the app actually calls them.
const modelsRes = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/models", {
    headers: { "Authorization": `Bearer ${key}` }
});

console.log("Status:", modelsRes.status);
console.log(await modelsRes.text());

console.log("\n--- Trying an actual chat completion with", model, "---");

const chatRes = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
    },
    body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Say hello in one word." }]
    })
});

console.log("Status:", chatRes.status);
console.log(await chatRes.text());