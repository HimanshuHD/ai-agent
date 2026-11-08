# Local AI Agent

A learning project for building a local AI agent in TypeScript with Node.js and Ollama.

## Goal

Build a command-line assistant that can use tools to answer a question. The
time tool reads the machine's current UTC time. Workspace tools list files and
read bounded text ranges, and search for literal text with evidence references.

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

## Select a workspace and list files

Repository tools are enabled only when you explicitly select a directory:

```powershell
npm start -- --workspace "D:\GitHub\example-project" "List the source files"
```

The directory must exist, be readable, and resolve to a directory before any model
request is made. The selected root is canonicalized, so explicitly selecting a
symlink to your repository selects its real location. Links below that root are
skipped. Prompt-only commands still expose only the time tool.

Add repeated `--exclude` options to hide sensitive files or directory subtrees:

```powershell
npm start -- --workspace "D:\GitHub\example-project" --exclude "private" --exclude "docs/internal" "List the available files"
```

Exclusions are literal workspace-relative paths, not globs. They also block direct
tool requests for those paths. They are case-sensitive on POSIX and case-insensitive
on Windows. `--exclude` requires a workspace. Use `--` to end option parsing when a
prompt starts with a literal `--` option. Duplicate workspace options, missing
values, unknown options, and empty prompts fail with a usage error.

### Listing contract

The model can request `list_files` with `{}` for the workspace root, or with
`{"directory":"src"}` for a subdirectory. No other arguments are accepted.
Only file paths are returned; this tool does not read file contents.

- Paths in results are relative to the workspace and use `/` separators.
- Results and directory traversal are sorted using JavaScript string ordering.
- Absolute paths, Windows drive paths, and paths escaping the workspace are rejected.
- Symbolic links and Windows directory junctions are skipped during traversal and
  rejected in explicitly requested directory paths, including parent components.
- Git metadata, `node_modules`, `vendor`, build output (`dist`, `build`, `.next`,
  `.nuxt`, `.output`), `coverage`, caches (`.cache`, `.turbo`, `__pycache__`), virtual
  environments (`.venv`, `venv`), credential directories (`.ssh`, `.aws`, `.azure`,
  `.gnupg`, `secrets`, `credentials`), `.env`/`.env.*`, and `.pem`/`.key`/`.p12`/`.pfx`
  files are excluded at every depth, with case-insensitive default name matching.
- Defaults: at most 8 directory levels below the requested directory, 10,000
  visited entries, and 500 returned file paths per call. Excluded entries count
  toward the visit limit; their directory contents are never traversed.
- Directory entries are streamed and retained only within the shared entry budget.
  If that budget stops a directory scan, the observed subset is sorted; it is not
  guaranteed to be the alphabetically first subset of the entire directory.
- Reaching the result cap conservatively marks the result truncated, even if the
  last returned file happened to be the final file.
- Missing or disallowed requested directories return a recoverable tool error.
  Failures within a listing are returned as relative-path errors with
  `incomplete: true`, so partial results cannot be mistaken for a complete scan.

Example result:

```json
{
  "directory": "src",
  "files": ["src/agent.ts", "src/index.ts"],
  "entriesVisited": 2,
  "truncated": false,
  "limitReasons": [],
  "incomplete": false,
  "errors": []
}
```

`limitReasons` can contain `depth`, `entries`, and `results`. A listing shares the
same five-tool-call run budget as the time tool, including failed requests.

This is read-only access to names in a local workspace, with no shell execution.
Default exclusions are not a complete secret detector; configure any additional
sensitive paths explicitly. Filesystem checks assume a stable local workspace;
they are not an OS sandbox against another process replacing paths concurrently.

### Workspace acceptance checks

Run `npm test`, `npm run lint`, and `npm run check`. Tests cover real temporary
workspaces, path containment, exclusions, links, limits, CLI parsing, tool history,
and mocked model integration. Directory permission failures are injected for
repeatable checks; the directory link fixture uses junctions when run on Windows.

With Ollama running, try these commands against a small repository:

```powershell
npm start -- --workspace "D:\GitHub\example-project" "List the source files"
npm start -- --workspace "D:\GitHub\example-project" "List files inside src"
npm start -- --workspace "D:\GitHub\example-project" --exclude "src" "List the available files"
npm start -- --workspace "D:\missing-project" "List files"
```

Expect `[tool] list_files` for listing requests, relative file names, no excluded
files, and an invalid-workspace error for the missing path before any model call.
The model may choose its own arguments, so automated fixtures provide the exact
checks for path rejection and limit boundaries. Also repeat the existing general
question and UTC-time examples without `--workspace` to confirm prompt-only use.

## Read repository files with evidence

With a workspace selected, the agent can use `read_file` to inspect text and cite
file paths and line numbers in its explanation:

```powershell
npm start -- --workspace "D:\GitHub\ai-agent" "Read src/index.ts and explain startup. Cite the file and relevant line numbers."
npm start -- --workspace "D:\GitHub\ai-agent" "Explain lines 1 through 30 of src/agent.ts using only the inspected source."
```

The model can request:

```json
{"path":"src/index.ts","startLine":1,"endLine":20}
```

`path` is required and must be a nonempty workspace-relative file path.
`startLine` and `endLine` are optional positive safe integers, inclusive and
one-based. `startLine` defaults to 1; omitted `endLine` requests the remaining
file within output limits. Reversed ranges are rejected. An end beyond EOF is
clamped to EOF. A start beyond EOF is an error, except that an empty file accepts
start 1 and returns zero lines. Unknown argument fields are rejected.

### Reading limits and text format

| Limit | Default |
| --- | --- |
| File size | 1 MiB (1,048,576 bytes) |
| Returned lines per call | 200 |
| Returned content per call | 16 KiB (16,384 UTF-8 bytes) |

Oversized files are rejected even when requesting a short range. Reads are bounded
to the file-size limit plus one detection byte, including when a file grows after
its initial size check. Only regular files are accepted. The opened handle is
closed on both success and failure.

The file must decode as UTF-8 (an optional BOM is accepted). Invalid UTF-8, NULs,
and unsupported control characters are rejected as binary or unsupported text.
Tabs, LF, CR, and form feed are accepted. This is a text heuristic, not a complete
binary-format detector; UTF-16 and other encodings are unsupported.

LF, CRLF, and CR are treated as line endings and returned content uses LF.
A trailing newline does not create an extra synthetic line. An empty file has
zero lines; a file containing only one newline has one blank line.

Example result:

```json
{
  "path": "src/index.ts",
  "startLine": 1,
  "endLine": 2,
  "totalLines": 3,
  "content": "import { runAgent } from \"./agent.js\";\nimport { parseArgs } from \"./cli.js\";",
  "truncated": false,
  "limitReasons": [],
  "partialLastLine": false
}
```

`endLine` is the last line represented in `content`. If no line is returned,
`endLine` is `startLine - 1` (0 for an empty file). `limitReasons` can contain
`lines` or `text`. UTF-8 characters are never split at the text boundary.
`partialLastLine` indicates when the final returned line contains only a prefix.
The byte limit applies to `content`, excluding JSON metadata and serialization.

For a line-limited result, the model can request a later range. A single line
longer than the byte cap is returned only as a prefix; this tool does not support
character offsets to retrieve its tail. The agent should state when that leaves
insufficient evidence.

### Access and answer behavior

Reading reuses the listing tool's workspace containment, default exclusions, and
configured `--exclude` paths. Symbolic links, directory junctions, and links in
parent components are rejected. The final file is also opened with no-follow
where the platform supports it. The stable-local-filesystem assumption described
above still applies.

Missing files, denied access, disallowed paths, binary files, invalid ranges, and
oversized files return descriptive tool errors to the model. They count toward
the same five-call budget, and their requests/results remain in history so the
agent can recover by choosing an allowed file.

The system instructions require explanations to cite inspected paths and relevant
line numbers, acknowledge incomplete evidence, and treat repository content as
untrusted data. File contents stay inside tool results rather than being promoted
to system instructions. These instructions guide model behavior; they do not
mechanically verify every citation or guarantee resistance to embedded prompts.

### File-reading acceptance checks

Run `npm test`, `npm run lint`, and `npm run check`. Automated checks cover ranges,
line endings, UTF-8 boundaries, file/output limits, file growth, handle cleanup,
errors, shared path controls, tool registration, conversation history, and recovery.

With Ollama running, use the first example above. Confirm `[tool] read_file`, then
check that the explanation cites `src/index.ts` and line numbers matching the file.
Verify cited code was actually read; a model-generated citation alone is not proof.

Repeat with `--exclude "src/index.ts"` and the same prompt. Confirm that source is
not read and the agent explains the access limitation or uses other available
sources without claiming it inspected the excluded file. Also ask for a missing
file and then an allowed file in one prompt to exercise recovery. Repeat the
existing listing and UTC-time examples to check both tools still work.

## Search repository text before reading

With a workspace selected, `search_text` locates relevant code using literal,
case-sensitive text. The agent can then use the returned paths and line numbers
to choose a `read_file` range:

```powershell
npm start -- --workspace "D:\GitHub\ai-agent" "Search for runAgent, read the relevant startup source, and explain the application entry point with file and line citations."
```

Tool arguments:

```json
{"query":"runAgent","directory":"src"}
```

`query` is required; `directory` is optional and defaults to the workspace root.
Unknown argument fields are rejected. Queries are single-line literals, not
regular expressions. Case, punctuation, and leading/trailing spaces are matched
exactly; no case folding or Unicode normalization is performed. Empty or
whitespace-only queries, NULs, CR/LF, and queries above 200 UTF-16 code units fail
validation. Searching for `a+b` matches those literal characters.

### Search results and completeness

Search returns one match per matching line, using its first literal occurrence
for the excerpt. Matches follow sorted relative file-path order, then ascending
one-based line numbers. Each match includes an excerpt (up to 240 UTF-16 code
units) and `excerptTruncated`; excerpt boundaries preserve surrogate pairs.

Example result:

```json
{
  "query": "runAgent",
  "directory": "src",
  "caseSensitive": true,
  "status": "matches",
  "matches": [
    {
      "path": "src/index.ts",
      "line": 8,
      "excerpt": "  console.log(await runAgent(prompt, workspace));",
      "excerptTruncated": false
    }
  ],
  "filesScanned": 1,
  "skippedBinary": 0,
  "skippedOversized": 0,
  "truncated": false,
  "incomplete": false,
  "limitReasons": [],
  "errors": []
}
```

The excerpt and line above illustrate the output structure; inspect your current
source to confirm actual line numbers. Status has three values:

- `matches`: completed search with at least one matching line.
- `no_matches`: completed search with no matches in eligible text files.
- `incomplete`: a limit or file/directory error prevented a complete search,
  whether or not some matches were found.

A result with no matches and `incomplete: true` must not be described as proof
that the query is absent from the workspace.

### Search limits

| Limit | Default |
| --- | --- |
| Query length | 200 UTF-16 code units |
| File size | 1 MiB, shared with file reading |
| File read attempts | 200 per search, including failures/skips |
| Returned matching lines | 100 |
| Excerpt length | 240 UTF-16 code units per match |
| Execution deadline | 5 seconds, including traversal |
| Candidate listing | Existing 8-level, 10,000-entry, 500-path limits |

`limitReasons` can contain `depth`, `entries`, `paths`, `files`, `matches`, `time`,
or `file_size`. Reaching the match cap conservatively marks the result incomplete.
Oversized files are skipped, counted in `skippedOversized`, and make results
incomplete because their text was not searched. Binary/unsupported-encoding files
are counted in `skippedBinary` and skipped as outside the eligible UTF-8 corpus.
Other access failures are returned in relative-path `errors` and make results
incomplete. No absolute filesystem paths are returned in these errors.

The deadline is cooperative: checks run while traversing entries, between file
reads, after a read, and while scanning lines. Once expiry is observed, no further
files are opened. An already-running OS filesystem operation cannot be forcibly
interrupted, so slow storage can make elapsed time exceed five seconds. File-size,
entry, attempt, and output bounds still apply.

Search reuses the same path containment, exclusions, symlink/junction rejection,
UTF-8 validation, binary checks, and bounded file reads. It inspects the whole
allowed file (within 1 MiB), so a match after line 200 or after the read tool's
16 KiB output window can still be found. Repository contents remain untrusted
tool data. Search and subsequent reads share the five-tool-call run budget.

### Search acceptance checks

Run `npm test`, `npm run lint`, and `npm run check`. Tests cover literal/case
behavior, excerpts and line references, no matches, exclusions, links, failures,
query/file/output/traversal limits, deadline checks, and search-to-read history.
Deadline tests inject a clock instead of waiting for real timeouts.

With Ollama running, use the example above. Confirm `[tool] search_text` followed
by `[tool] read_file`; compare final citations against the source actually read.
Also try a nonexistent identifier and a search restricted to an excluded path:

```powershell
npm start -- --workspace "D:\GitHub\ai-agent" "Search for identifier_that_does_not_exist_93821 and report whether the search was complete."
npm start -- --workspace "D:\GitHub\ai-agent" --exclude "src" "Search inside src for runAgent."
```

Expect an explicit complete no-match result for the first prompt if no limits or
access errors occur, and a clear access limitation for the excluded directory.
Repeat existing reading, listing, general-question, and UTC-time examples.

## Interactive conversations

Start an in-memory terminal conversation:

```powershell
npm start -- --interactive
npm start -- --interactive --workspace "D:\GitHub\ai-agent" --exclude "private"
```

Enter prompts at `>`. Do not supply an initial prompt alongside `--interactive`;
enter it after the session opens. One-shot commands continue to work as before.

| Input | Behavior |
| --- | --- |
| A nonempty prompt | Run one user turn and retain successful context |
| Empty or whitespace-only input | Ignore without calling the model |
| `/reset` | Clear conversation history while retaining workspace/exclusions |
| `/exit` | End the session |
| Ctrl+C | Cancel an active model request and end the session |
| EOF | Finish accepted queued input and end the session |

Slash-prefixed input is reserved for commands; unknown commands show help without
calling the model. Prompts run sequentially. Input entered while a turn is running
is queued, so `/reset` and `/exit` run after that turn; use Ctrl+C for immediate
interruption. In PowerShell, EOF can be sent with Ctrl+Z then Enter; POSIX terminals
usually use Ctrl+D on an empty line.

Try a follow-up conversation:

```text
> Remember that I am learning Vue composables.
> What topic did I ask you to remember?
> /reset
> What topic did I ask you to remember?
> /exit
```

After reset, the earlier topic is no longer in the model's conversation context.
With a workspace selected, listing, reading, and search are available throughout
the session. The selected canonical root and exclusions are copied when the
session starts and cannot be changed by a later prompt or reset.

### Session history policy

| Boundary | Default |
| --- | --- |
| Retained complete user turns | At most 10 |
| Serialized retained messages, including system instructions | At most 256 KiB UTF-8 JSON |
| Interactive prompt size | At most 16 KiB UTF-8 |
| Active request history, including current turn | At most 1 MiB UTF-8 JSON |
| Tool-call budget | Five requested calls for every user turn |

A turn includes its user prompt, assistant tool requests, corresponding tool
results, and final assistant answer. History evicts oldest complete turns until
both retention limits are satisfied. Individual tool messages are never removed
from the middle of a retained exchange. The CLI prints a `[history]` notice when
turns are dropped. There is no automatic summarization.

If one successful turn alone exceeds the 256 KiB retention budget, its answer is
shown but that entire turn is discarded from retained history, along with older
turns as needed. A follow-up cannot rely on discarded context. If active history
exceeds 1 MiB, the turn fails instead of making another oversized model request
or committing that answer. These checks bound serialized history, not every
transient allocation made by the HTTP client or model runtime.

Only successful turns are committed. Transport errors, malformed responses,
empty answers, exceeded tool budgets, oversized active history, and cancellation
leave previously committed history unchanged. A failed interactive turn reports
its error and accepts the next prompt. Each new turn gets five fresh tool calls,
including failed tool requests. Reset and failed turns retain the workspace.

Session state exists only in memory and is lost when the process exits. Separate
sessions do not share history. One-shot failures and invalid startup options keep
a nonzero exit status; normal interactive exit, EOF, and handled Ctrl+C exit
cleanly. A recoverable interactive turn error does not terminate the session.

### Execution and terminal separation

`AgentSession` owns retained history and provides `run`, `reset`, and defensive
`getHistory` snapshots. It uses the same `runTurn` implementation as one-shot
`runAgent`. Execution emits optional `onTool` callbacks and accepts an abort
signal; terminal input/output belongs to the CLI adapter.

The Ollama client combines cancellation with its existing 180-second timeout.
Ctrl+C aborts pending model transport and prevents another model request. Local
filesystem operations already in flight finish before the engine observes
cancellation at the next checkpoint; they cannot be forcibly interrupted.

### Interactive acceptance checks

Run `npm test`, `npm run lint`, and `npm run check`. Tests cover session isolation,
follow-up history, reset, workspace preservation, whole-turn retention limits,
per-turn tool budgets, failures, cancellation, EOF, and terminal subprocess flows.
POSIX subprocess signal tests run on POSIX; check native Ctrl+C manually on Windows.

With Ollama running:

1. Start `npm start -- --interactive` and run the Vue-topic conversation above.
2. Confirm the follow-up recalls the topic before reset and does not rely on it
   after reset. Empty input should not start model activity.
3. Ask for the UTC time twice; confirm the time tool is available on both turns.
4. Start with a workspace, ask to search/read startup code, then ask a related
   follow-up. Verify file and line citations against inspected source.
5. Use `/reset`; confirm repository tools and exclusions still apply.
6. During a slow answer, press Ctrl+C. Confirm clean exit without waiting for the
   180-second timeout. Also test idle Ctrl+C, EOF, and `/exit`.
7. Run an existing one-shot general question and UTC-time command.

## Local web interface

The Vue interface uses the same agent engine and `AgentSession` as the CLI.
Start Ollama and make the selected model available, then build and start:

```powershell
npm ci
npm run build
$env:AGENT_WORKSPACE = "D:\GitHub\ai-agent"
$env:AGENT_EXCLUDE = "private,docs/internal"
# Optional: $env:OLLAMA_MODEL = "qwen3:1.7b"
npm run web:server
```

Open **http://127.0.0.1:3000/**. Omit `AGENT_WORKSPACE` for general questions and
the time tool only. The workspace is validated and canonicalized before startup;
web requests cannot select or change it. `AGENT_EXCLUDE` is a comma-separated list
of literal workspace-relative exclusions, using the existing filesystem rules.
The backend binds to `127.0.0.1`; remote/multi-user hosting is outside this delivery.

Use Enter to send, Shift+Enter for a new line, **Cancel run** to abort, and
**Reset conversation** to clear the model context while retaining the workspace.
Tool running/completed/failed events appear as they happen. Output is rendered as
plain text through Vue interpolation; HTML and Markdown are not executed.
Messages cannot be submitted twice while a run is active.

Each page load opens a separate conversation with a random bearer capability held
only in page memory. Refresh starts a new conversation. **New connection** deletes
the previous session before opening another; use it to recover from expiry.
Closing a tab abandons its session until expiry, but disconnecting its active
response aborts that run. Tokens and conversations are not saved to disk.

### Web runtime limits

| Boundary | Default |
| --- | --- |
| Browser sessions | 20 |
| Idle session expiry | 30 minutes |
| Absolute session lifetime | 2 hours |
| Active runs per session | 1 |
| Active runs across the server | 2 |
| Overall web run deadline | 180 seconds |
| JSON request body | 20 KiB |
| Prompt | 16 KiB UTF-8 |
| Model history | Existing 10-turn / 256 KiB retention and 1 MiB active limit |
| Visible browser transcript | Latest 20 turns |

Expired sessions are removed on requests and by periodic cleanup. Cancelling,
disconnecting, or timing out aborts model transport and leaves prior committed
history intact. A filesystem tool already in progress may finish under its own
bounds before cancellation is observed. Reset is rejected during an active run.
A history-drop notice explains when older messages visible in the transcript are
no longer present in model context.

### Development and browser checks

Run the backend as above. In another terminal, run `npm run web:dev` and open
**http://127.0.0.1:5173/**. Vite proxies `/api` to port 3000. If changing the backend
port, update the proxy target in `vite.config.ts` as well.

```powershell
npm test
npm run lint
npm run check
npx playwright install chromium
npm run test:browser
```

`npm test` builds the Node code and runs CLI/session/filesystem/API checks.
`npm run check` includes Vue/TypeScript, and `npm run build` builds Node plus the
static frontend in `web-dist`. Browser checks use the real HTTP backend and a
mocked model, so Ollama is not required. They cover conversations, isolation,
reset, tools, safe output, failure/retry, cancellation, deadlines, keyboard use,
and mobile overflow. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` only when using an
existing compatible Chromium installation. Screenshots go to the OS temp folder.

For live acceptance, ask for the UTC time, then search/read startup code and verify
file/line citations. Ask a follow-up; open a second tab and confirm it has separate
context. Reset, cancel a slow run, and repeat an existing CLI command. Live model
behavior and Windows-specific checks require a local Ollama setup.

### API and origin boundary

All API calls require `X-Agent-Client: local-web` and JSON bodies. Session routes
also require `Authorization: Bearer <session token>`. Browser origins must match
the server's loopback origin or the explicit allowlist; Host headers must match
localhost/127.0.0.1 with the actual port. The default additional origins are
`http://127.0.0.1:5173` and `http://localhost:5173` for development. Set
`WEB_ALLOWED_ORIGINS` to a comma-separated replacement list of exact HTTP(S)
origins without paths or trailing slashes. Wildcards are not supported.

| Route | Behavior |
| --- | --- |
| POST /api/sessions | Create isolated session; body `{}` |
| POST /api/prompt | Run `{ "prompt": "..." }`; stream newline-delimited JSON events |
| POST /api/reset | Clear this session; body `{}` |
| POST /api/cancel | Cancel this session's active run; body `{}` |
| DELETE /api/session | Delete/cancel this session; body `{}` |

Stream events are `running`, `tool`, `answer`, `error`, or `cancelled`. Non-stream
errors use `{ "error": { "code": "...", "message": "..." } }` and HTTP status
codes. The frontend receives metadata and allowed tool results, not a general
filesystem endpoint. Origin checks and bearer capabilities are local boundaries,
not a substitute for authentication for remote hosting or protection from other
trusted local processes.

### Static hosting compatibility

`VITE_BASE_PATH` sets the frontend build base (for example `/ai-agent/`).
`VITE_API_URL` sets the backend origin (for example `http://127.0.0.1:3000`),
defaulting to same-origin `/api`. Both are build-time variables. `WEB_BASE_PATH`
sets the matching prefix when serving a subpath through the local Node server.
`PORT` sets the backend port, defaulting to 3000. Ollama model selection remains
independently controlled by `OLLAMA_MODEL`.

GitHub Pages can host `web-dist`, but cannot run Node or Ollama. Pages deployment,
HTTPS-to-loopback browser permissions, mixed-content behavior, streaming, and CORS
compatibility are tracked in **#14**. A hosted frontend does not automatically gain
access to a local backend; only explicitly allowed origins may connect.

Troubleshooting: build before starting the production server; ensure Ollama is
running for model answers; use New connection after session expiry; wait or cancel
when server concurrency is full; check exact allowed origins and the Vite proxy
port when browser requests fail. A connected backend does not by itself confirm
that the selected Ollama model is available.
