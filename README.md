# Local AI Agent

A learning project for building a local AI agent in TypeScript with Node.js and Ollama.

## Goal

Build a command-line assistant that can use tools to answer a question. The
time tool reads the machine's current UTC time. Workspace tools list files and
read bounded text ranges. Repository text search is a planned follow-up.

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
