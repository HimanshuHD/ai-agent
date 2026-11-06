import { chat } from "./ollama.js";

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
    console.error('Usage: npm start -- "Your prompt"');
    process.exitCode = 1;
} else {
    try {
        const reply = await chat([{ role: "user", content: prompt }]);
        console.log(reply.content);
    } catch (error) {
        console.error("Could not complete the local model request.", error);
        process.exitCode = 1;
    }
}