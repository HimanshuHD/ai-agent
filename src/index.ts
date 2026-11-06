const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  console.error('Usage: npm start -- "Your prompt"');
  process.exitCode = 1;
} else {
  console.log(prompt);
}