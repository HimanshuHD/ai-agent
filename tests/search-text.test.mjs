import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAgent } from "../dist/agent.js";
import { searchText, searchLimits } from "../dist/search-text.js";
import { createWorkspace } from "../dist/workspace.js";

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return { root, workspace: await createWorkspace(root) };
}

const tool = args => ({ role: "assistant", content: "Finding the implementation.", tool_calls: [{ function: { name: "search_text", arguments: args } }] });
const answer = { role: "assistant", content: "Startup is described in src/main.ts:2." };
function model(t, replies) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    assert.ok(replies.length);
    return Response.json({ message: replies.shift() });
  });
  return requests;
}

test("literal case-sensitive search returns ordered paths, exact line numbers, and excerpts", async (t) => {
  const { workspace } = await fixture(t, { "z.ts": "a+b[0].x", "src/a.ts": "header\r\na+b[0].x twice a+b[0].x\r\nA+B[0].x\r\n" });
  const result = await searchText(workspace, "a+b[0].x");
  assert.equal(result.status, "matches");
  assert.equal(result.incomplete, false);
  assert.equal(result.caseSensitive, true);
  assert.deepEqual(result.matches.map(match => [match.path, match.line]), [["src/a.ts", 2], ["z.ts", 1]]);
  assert.equal(result.matches[0].excerpt, "a+b[0].x twice a+b[0].x");
  assert.equal(result.matches[0].excerptTruncated, false);
  assert.deepEqual((await searchText(workspace, "A+B[0].x", "src")).matches.map(match => match.line), [3]);
});

test("complete no-match and empty-workspace searches are explicit", async (t) => {
  const { workspace } = await fixture(t, { "a.txt": "hello" });
  const result = await searchText(workspace, "absent");
  assert.equal(result.status, "no_matches");
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.matches, []);
  assert.equal((await searchText((await fixture(t)).workspace, "absent")).status, "no_matches");
});

test("empty, oversized, multiline, and NUL queries are rejected", async (t) => {
  const { workspace } = await fixture(t);
  for (const query of ["", "  ", "a".repeat(201), "a\nb", "a\rb", "a\0b"]) {
    await assert.rejects(searchText(workspace, query), /query/);
  }
  assert.equal((await searchText(workspace, "a".repeat(200))).status, "no_matches");
});

test("query spaces are literal and excerpts remain bounded around a match", async (t) => {
  const { workspace } = await fixture(t, { "a.txt": `${"😀".repeat(500)} needle ${"😀".repeat(500)}` });
  const result = await searchText(workspace, " needle ");
  const match = result.matches[0];
  assert.ok(match.excerpt.includes(" needle "));
  assert.ok(match.excerpt.length <= searchLimits.maxExcerptLength);
  assert.equal(match.excerptTruncated, true);
  assert.ok(!/[\uDC00-\uDFFF]/.test(match.excerpt[0]));
  assert.ok(!/[\uD800-\uDBFF]/.test(match.excerpt.at(-1)));
});

test("exclusions and binary files are skipped without searching their contents", async (t) => {
  const { root } = await fixture(t, { "src/a.ts": "needle", "private/a.txt": "needle", ".env": "needle", "node_modules/pkg/a.js": "needle", "dist/a.js": "needle", "raw.bin": Buffer.from([0, 1, 2]), "invalid.bin": Buffer.from([0xff]) });
  const workspace = await createWorkspace(root, ["private"]);
  const result = await searchText(workspace, "needle");
  assert.deepEqual(result.matches.map(match => match.path), ["src/a.ts"]);
  assert.equal(result.skippedBinary, 2);
  assert.equal(result.incomplete, false);
  await assert.rejects(searchText(workspace, "needle", "private"), /excluded/);
});

test("links and junctions are skipped and direct linked directories are rejected", async (t) => {
  const { root, workspace } = await fixture(t, { "src/a.ts": "needle" });
  await symlink(path.join(root, "src"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  if (process.platform !== "win32") await symlink(path.join(root, "src/a.ts"), path.join(root, "alias.ts"));
  assert.deepEqual((await searchText(workspace, "needle")).matches.map(match => match.path), ["src/a.ts"]);
  await assert.rejects(searchText(workspace, "needle", "alias"), /links|junctions/);
});

test("directory input obeys shared containment rules", async (t) => {
  const { workspace } = await fixture(t, { "src/a.ts": "needle" });
  for (const directory of ["..", "../outside", "/etc", "C:\\Windows", "C:Windows", "\\\\host\\share", "missing", "src/a.ts"]) {
    await assert.rejects(searchText(workspace, "needle", directory));
  }
  assert.equal((await searchText(workspace, "needle", "src")).matches.length, 1);
});

test("file and match caps distinguish incomplete results from no matches", async (t) => {
  const { workspace } = await fixture(t, { "a.ts": "one", "b.ts": "needle\nneedle" });
  const files = await searchText(workspace, "needle", ".", { ...searchLimits, maxFiles: 1 });
  assert.equal(files.status, "incomplete");
  assert.equal(files.filesScanned, 1);
  assert.deepEqual(files.matches, []);
  assert.ok(files.limitReasons.includes("files"));
  const matches = await searchText(workspace, "needle", ".", { ...searchLimits, maxMatches: 1 });
  assert.equal(matches.matches.length, 1);
  assert.equal(matches.status, "incomplete");
  assert.ok(matches.limitReasons.includes("matches"));
});

test("oversized files are skipped with an explicit completeness limit", async (t) => {
  const { workspace } = await fixture(t, { "large.txt": "a".repeat(1_048_577), "small.txt": "needle" });
  const result = await searchText(workspace, "needle");
  assert.equal(result.skippedOversized, 1);
  assert.equal(result.status, "incomplete");
  assert.ok(result.limitReasons.includes("file_size"));
  assert.deepEqual(result.matches.map(match => match.path), ["small.txt"]);
});

test("directory depth limits propagate to search completeness", async (t) => {
  const { workspace } = await fixture(t, { [`${"nested/".repeat(10)}a.ts`]: "needle" });
  const result = await searchText(workspace, "needle");
  assert.equal(result.status, "incomplete");
  assert.ok(result.limitReasons.includes("depth"));
});

test("deadline is checked during traversal", async (t) => {
  const { workspace } = await fixture(t, { "a.ts": "needle" });
  let clock = 0;
  const original = fs.opendir;
  t.mock.method(fs, "opendir", async (...args) => {
    const handle = await original(...args);
    clock = 6000;
    return handle;
  });
  const result = await searchText(workspace, "needle", ".", searchLimits, () => clock);
  assert.equal(result.status, "incomplete");
  assert.ok(result.limitReasons.includes("time"));
  assert.equal(result.filesScanned, 0);
});

test("deadline after an in-flight file read prevents further reads", async (t) => {
  const { workspace } = await fixture(t, { "a.ts": "needle", "b.ts": "needle" });
  let clock = 0;
  let opens = 0;
  const original = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    opens += 1;
    const handle = await original(...args);
    clock = 6000;
    return handle;
  });
  const result = await searchText(workspace, "needle", ".", searchLimits, () => clock);
  assert.equal(result.status, "incomplete");
  assert.ok(result.limitReasons.includes("time"));
  assert.equal(opens, 1);
  assert.equal(result.matches.length, 0);
});

test("file failures retain other matches and report relative errors", async (t) => {
  const { workspace } = await fixture(t, { "a.ts": "needle", "b.ts": "needle" });
  const original = fs.open;
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file.endsWith("a.ts")) throw Object.assign(new Error("private absolute path"), { code: "EACCES" });
    return original(file, ...args);
  });
  const result = await searchText(workspace, "needle");
  assert.equal(result.status, "incomplete");
  assert.equal(result.filesScanned, 2);
  assert.deepEqual(result.errors, [{ path: "a.ts", error: "File access denied." }]);
  assert.deepEqual(result.matches.map(match => match.path), ["b.ts"]);
});

test("search can guide a subsequent read with complete evidence history", async (t) => {
  const { workspace } = await fixture(t, { "src/main.ts": "header\nstartApplication();\n" });
  const first = tool({ query: "startApplication" });
  const second = { role: "assistant", content: "Reading the match.", tool_calls: [{ function: { name: "read_file", arguments: { path: "src/main.ts", startLine: 2, endLine: 2 } } }] };
  const requests = model(t, [first, second, answer]);
  t.mock.method(console, "error", () => {});
  assert.equal(await runAgent("Find startup", workspace), answer.content);
  assert.match(requests[0].messages[0].content, /Use search_text to locate/);
  assert.ok(requests[0].tools.some(tool => tool.function.name === "search_text"));
  assert.deepEqual(requests[1].messages[2], first);
  const search = JSON.parse(requests[1].messages[3].content);
  assert.equal(search.matches[0].line, 2);
  const read = JSON.parse(requests[2].messages[5].content);
  assert.equal(read.path, "src/main.ts");
  assert.equal(read.content, "startApplication();");
});

test("invalid search arguments return recoverable errors and consume the shared budget", async (t) => {
  const { workspace } = await fixture(t);
  const requests = model(t, [tool({ query: 1 }), tool({ query: "" }), tool({ query: "x", directory: 42 }), tool({ query: "x", extra: true }), tool({ query: "x" }), answer]);
  t.mock.method(console, "error", () => {});
  await runAgent("Find", workspace);
  const results = requests.at(-1).messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content));
  assert.equal(results.length, 5);
  for (const result of results.slice(0, 4)) assert.ok(result.error);
  assert.equal(results[4].status, "no_matches");
  assert.deepEqual(requests.at(-1).tools, []);
});

test("search_text is unavailable without a workspace", async (t) => {
  const requests = model(t, [tool({ query: "x" }), answer]);
  await runAgent("Find");
  assert.ok(!requests[0].tools.some(tool => tool.function.name === "search_text"));
  assert.match(JSON.parse(requests[1].messages[3].content).error, /Unknown tool/);
});

test("listing path caps are preserved in search results", async (t) => {
  const files = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`${String(index).padStart(4, "0")}.txt`, ""]));
  const { workspace } = await fixture(t, files);
  const result = await searchText(workspace, "absent");
  assert.equal(result.status, "incomplete");
  assert.ok(result.limitReasons.includes("paths"));
  assert.ok(result.filesScanned <= searchLimits.maxFiles);
});

test("search finds text beyond the read tool's initial output window", async (t) => {
  const { workspace } = await fixture(t, { "a.ts": `${"x".repeat(20000)}\n${"filler\n".repeat(250)}needle` });
  const result = await searchText(workspace, "needle");
  assert.equal(result.status, "matches");
  assert.equal(result.matches[0].line, 252);
  assert.equal(result.matches[0].excerpt, "needle");
});
