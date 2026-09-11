import "dotenv/config";

const key = process.env.CEREBRAS_API_KEY;
const model = process.env.CEREBRAS_MODEL || "llama-3.3-70b";

console.log("CEREBRAS_API_KEY present:", Boolean(key));
console.log("CEREBRAS_MODEL in use:", model);

if (!key) {
    console.log("No CEREBRAS_API_KEY found in .env - stopping here.");
    process.exit(1);
}

console.log("\n--- Checking available models on your account ---");

const modelsRes = await fetch("https://api.cerebras.ai/v1/models", {
    headers: { "Authorization": `Bearer ${key}` }
});

console.log("Status:", modelsRes.status);
console.log(await modelsRes.text());

console.log("\n--- Trying an actual chat completion with", model, "---");

const chatRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
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
