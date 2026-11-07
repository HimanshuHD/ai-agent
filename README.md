# Local AI Agent

A learning project for building a local AI agent in TypeScript with Node.js and Ollama.

## Goal

Build a command-line assistant that can use tools to answer a question. The
first tool reads the machine's current UTC time. Repository search and file
reading are planned follow-ups.

## Requirements

- Git
- Node.js 24
- Ollama and the `qwen3:1.7b` model for local inference

## Run locally

Start Ollama, then run these commands from the repository root:

```powershell
ollama pull qwen3:1.7b
npm ci
npm run build
npm start -- "Explain a Vue composable in two sentences."
```

Run `npm run build` again after editing the TypeScript source. To use another
downloaded model, set `OLLAMA_MODEL` in your terminal before running the CLI.

## Try the agent

```powershell
npm start -- "What is the current UTC time? Include the full ISO timestamp."
```

Look for `[tool] get_current_time` before the final answer. Each run has a
budget of five tool calls.

## Code quality

Check code style and common issues:

```powershell
npm.cmd run lint
```

Apply automatic formatting and lint fixes:

```powershell
npm.cmd run lint:fix
```

Check types and compile:

```powershell
npm.cmd run check
npm.cmd run build
```

TypeScript code uses two-space indentation, double quotes, and semicolons.
## Response validation and execution limits

Ollama responses are checked at runtime before entering conversation history or
executing tools. A response must contain an assistant message with string content.
Optional tool calls must be an array, and every call must have a nonempty function
name and an argument object (not null, an array, or a primitive).

`get_current_time` accepts only an empty object. Unknown tools and unexpected
arguments return descriptive tool errors to the model without executing a tool.
Every requested call, including a rejected request, consumes one of the five calls
allowed per run. A batch that exceeds the remaining budget is rejected in full
before any call in that batch executes. Accepted batches retain the assistant's
content and tool requests alongside one result per request in model history.

Empty final answers and malformed responses fail the run. Connection failures,
HTTP errors, and the existing 180-second request timeout also fail with an error;
the CLI exits with a nonzero status. `OLLAMA_MODEL` still selects the model.

## Test the validation and limits

```powershell
npm test
npm run lint
npm run check
```

The tests use mocked Ollama responses and Node's built-in test runner; Ollama is
not required. They cover response shapes, time-tool history, rejected requests,
exact and exceeded budgets, atomic batch rejection, transport errors, empty
answers, model configuration, and CLI exit codes. `npm test` builds the CLI first.

For a live smoke check, start Ollama and run both examples in **Run locally** and
**Try the agent**. Confirm a general question returns text, and a time question
logs `[tool] get_current_time` and returns a UTC answer based on the tool result.
Stop Ollama and rerun a prompt to confirm a connection error and nonzero exit code
(`$LASTEXITCODE` in PowerShell). Restart Ollama after the check.
