import { chat } from "./ollama.js";
import { runAgent } from "./agent.js";

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
    console.error('Usage: npm start -- "Your prompt"');
    process.exitCode = 1;
} else {
    try {
        console.log(await runAgent(prompt));
    } catch (error) {
        console.error("Agent run failed..!!", error);
        process.exitCode = 1;
    }
}