# Local AI Agent

A learning project for building a local AI agent in TypeScript with Node.js and Ollama.

## Goal

Build a command-line assistant that can use tools to answer a question. The
first tool reads the machine's current UTC time. Repository search and file
reading are planned follow-ups.

## Requirements

- Git
- Node.js 24
- Ollama and the `qwen3.5:4b` model for local inference

## Run locally

Start Ollama, then run these commands from the repository root:

```powershell
ollama pull qwen3.5:4b
npm ci
npm run build
npm start -- "Explain a Vue composable in two sentences."
```

Run `npm run build` again after editing the TypeScript source. To use another
downloaded model, set `OLLAMA_MODEL` in your terminal before running the CLI.