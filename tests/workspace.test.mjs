import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArgs } from "../dist/cli.js";
import { createWorkspace, listFiles, listingLimits } from "../dist/workspace.js";
import { runAgent } from "../dist/agent.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function file(root, name) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), "fixture");
}

function model(t, replies) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    assert.ok(replies.length);
    return Response.json({ message: replies.shift() });
  });
  return requests;
}
const call = args => ({ role: "assistant", content: "Checking files.", tool_calls: [{ function: { name: "list_files", arguments: args } }] });
const answer = { role: "assistant", content: "done" };

test("CLI parses workspace, repeated exclusions, and prompt independently", () => {
  assert.deepEqual(parseArgs(["hello", "world"]), { prompt: "hello world", workspacePath: undefined, excludePaths: [] });
  assert.deepEqual(parseArgs(["--workspace", "D:\\GitHub\\project", "--exclude", "private", "list", "--exclude", "docs/internal", "files"]), {
    prompt: "list files", workspacePath: "D:\\GitHub\\project", excludePaths: ["private", "docs/internal"],
  });
  assert.equal(parseArgs(["--", "--literal", "prompt"]).prompt, "--literal prompt");
});

test("CLI rejects missing options, duplicate workspace, unknown flags, and empty prompts", () => {
  for (const args of [[], [" "], ["--workspace"], ["--workspace", "--other", "hi"], ["--exclude"],
    ["--unknown", "hi"], ["--workspace", "a", "--workspace", "b", "hi"], ["--exclude", "private", "hi"]]) {
    assert.throws(() => parseArgs(args));
  }
});

test("workspace validates directories and canonicalizes an explicitly selected root", async (t) => {
  const root = await fixture(t);
  await file(root, "a.txt");
  const workspace = await createWorkspace(path.join(root, "."));
  assert.equal(workspace.root, await realpath(root));
  await assert.rejects(createWorkspace(path.join(root, "missing")), /Invalid workspace/);
  await assert.rejects(createWorkspace(path.join(root, "a.txt")), /Invalid workspace/);
  await symlink(root, `${root}-link`, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rm(`${root}-link`, { force: true, recursive: true }));
  assert.equal((await createWorkspace(`${root}-link`)).root, workspace.root);
});

test("listing is relative, sorted, repeatable, and supports subdirectories", async (t) => {
  const root = await fixture(t);
  for (const name of ["z.txt", "src/b.ts", "a.txt", "src/a.ts"]) await file(root, name);
  const workspace = await createWorkspace(root);
  const result = await listFiles(workspace);
  assert.deepEqual(result.files, ["a.txt", "src/a.ts", "src/b.ts", "z.txt"]);
  assert.equal(result.truncated, false);
  assert.equal(result.incomplete, false);
  assert.deepEqual(await listFiles(workspace), result);
  assert.deepEqual((await listFiles(workspace, "src")).files, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual((await listFiles(workspace, "src\\.")).files, ["src/a.ts", "src/b.ts"]);
});

test("default and configured exclusions apply at every depth", async (t) => {
  const root = await fixture(t);
  const excluded = [".git/config", "node_modules/pkg/a.js", "dist/app.js", ".env", ".env.local", "cert.key", "cert.pem",
    "src/.aws/config", "src/secrets/token", "private/data.txt", "docs/internal/info.txt"];
  for (const name of [...excluded, "src/main.ts", "docs/public.txt"]) await file(root, name);
  const workspace = await createWorkspace(root, ["private/", "docs/internal/"]);
  assert.deepEqual((await listFiles(workspace)).files, ["docs/public.txt", "src/main.ts"]);
  for (const name of [".git", "node_modules", "private", "docs/internal", "src/.aws"]) {
    await assert.rejects(listFiles(workspace, name), /excluded/);
  }
  for (const name of ["..", "/tmp", "C:\\private", "."]) {
    await assert.rejects(createWorkspace(root, [name]));
  }
});

test("links and junctions are skipped and cannot be requested directly or through a parent", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await file(outside, "secret.txt");
  await file(root, "allowed/a.txt");
  const kind = process.platform === "win32" ? "junction" : "dir";
  await symlink(outside, path.join(root, "outside"), kind);
  await symlink(path.join(root, "allowed"), path.join(root, "inside"), kind);
  if (process.platform !== "win32") await symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
  const workspace = await createWorkspace(root);
  assert.deepEqual((await listFiles(workspace)).files, ["allowed/a.txt"]);
  for (const name of ["inside", "outside", "outside/child"]) {
    await assert.rejects(listFiles(workspace, name), /links|junctions/);
  }
});

test("absolute paths, drive paths, escapes, missing paths, and file paths are rejected", async (t) => {
  const root = await fixture(t);
  await file(root, "file.txt");
  const workspace = await createWorkspace(root);
  for (const input of ["/etc", "C:\\Windows", "C:Windows", "\\\\server\\share", "..", "../sibling", "sub/../../outside", "..\\outside", "bad\0name", "missing", "file.txt"]) {
    await assert.rejects(listFiles(workspace, input));
  }
});

test("depth, entry, and result caps report incomplete results explicitly", async (t) => {
  const root = await fixture(t);
  await file(root, "a.txt");
  await file(root, "b.txt");
  await file(root, "nested/deep/file.txt");
  const workspace = await createWorkspace(root);
  for (const [override, reason] of [[{ maxDepth: 0 }, "depth"], [{ maxEntries: 1 }, "entries"], [{ maxResults: 1 }, "results"]]) {
    const limits = { ...listingLimits, ...override };
    const result = await listFiles(workspace, ".", limits);
    assert.equal(result.truncated, true);
    assert.equal(result.incomplete, true);
    assert.ok(result.limitReasons.includes(reason));
    assert.ok(result.entriesVisited <= limits.maxEntries);
    assert.ok(result.files.length <= limits.maxResults);
  }
  const empty = await fixture(t);
  assert.deepEqual((await listFiles(await createWorkspace(empty))).files, []);
  await assert.rejects(listFiles(workspace, ".", { ...listingLimits, maxEntries: 0 }), /Invalid listing limit/);
});

test("a removed workspace fails clearly", async (t) => {
  const root = await fixture(t);
  const workspace = await createWorkspace(root);
  await rm(root, { recursive: true });
  await assert.rejects(listFiles(workspace));
});

test("workspace registers listing and returns its result with complete history", async (t) => {
  const root = await fixture(t);
  await file(root, "src/main.ts");
  const requests = model(t, [call({ directory: "src" }), answer]);
  t.mock.method(console, "error", () => {});
  assert.equal(await runAgent("list", await createWorkspace(root)), "done");
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ["get_current_time", "list_files", "read_file", "search_text"]);
  assert.deepEqual(requests[1].messages[2], call({ directory: "src" }));
  const result = JSON.parse(requests[1].messages[3].content);
  assert.deepEqual(result.files, ["src/main.ts"]);
  assert.equal(result.directory, "src");
});

test("prompt-only mode does not expose or execute listing", async (t) => {
  const requests = model(t, [call({}), answer]);
  await runAgent("list");
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ["get_current_time"]);
  assert.match(JSON.parse(requests[1].messages[3].content).error, /Unknown tool/);
});

test("listing argument and filesystem errors are recoverable tool results", async (t) => {
  const root = await fixture(t);
  const workspace = await createWorkspace(root);
  const requests = model(t, [call({ directory: 42 }), call({ unexpected: true }), call({ directory: "../outside" }), call({ directory: "missing" }), answer]);
  t.mock.method(console, "error", () => {});
  assert.equal(await runAgent("list", workspace), "done");
  const results = requests.at(-1).messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content));
  assert.match(results[0].error, /Invalid arguments/);
  assert.match(results[1].error, /Invalid arguments/);
  assert.match(results[2].error, /inside the workspace/);
  assert.match(results[3].error, /missing or inaccessible/);
});

test("invalid CLI workspace fails before making a model request", async (t) => {
  const root = await fixture(t);
  const script = `
    globalThis.fetch = async () => { process.exit(99); };
    await import('./dist/index.js');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, "unused", "--workspace", path.join(root, "missing"), "list"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid workspace/);
});

test("unreadable subdirectories produce partial results with relative errors", async (t) => {
  const root = await fixture(t);
  await file(root, "allowed.txt");
  await file(root, "denied/private.txt");
  const workspace = await createWorkspace(root);
  const original = fs.opendir;
  t.mock.method(fs, "opendir", async (directory, ...args) => {
    if (directory === path.join(root, "denied")) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return original(directory, ...args);
  });
  const listing = await listFiles(workspace);
  assert.deepEqual(listing.files, ["allowed.txt"]);
  assert.equal(listing.incomplete, true);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.errors, [{ path: "denied", error: "Could not list directory." }]);
});

test("default result cap remains bounded for a large directory", async (t) => {
  const root = await fixture(t);
  for (let index = 0; index < 510; index += 1) await file(root, `${String(index).padStart(4, "0")}.txt`);
  const listing = await listFiles(await createWorkspace(root));
  assert.equal(listing.files.length, 500);
  assert.equal(listing.truncated, true);
  assert.ok(listing.limitReasons.includes("results"));
  assert.deepEqual(listing.files, [...listing.files].sort());
});
