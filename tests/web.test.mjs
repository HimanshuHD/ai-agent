import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createWebServer, parseOrigins } from "../dist/web-server.js";
import { WebSessions, webLimits } from "../dist/web-sessions.js";
import { createWorkspace } from "../dist/workspace.js";
const httpFetch = globalThis.fetch;
async function start(t, options = {}) {
  const app = createWebServer(options);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.sessions.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
  });
  const post = (route, data = {}, token, headers = {}, method = "POST") => httpFetch(`${url}/api/${route}`, {
    method, headers: { "Content-Type": "application/json", "X-Agent-Client": "local-web", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(data),
  });
  return { ...app, url, post, session: async () => (await (await post("sessions")).json()).token };
}
function model(t, responses) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    assert.ok(responses.length);
    return Response.json({ message: responses.shift() });
  });
  return requests;
}
const answer = content => ({ role: "assistant", content });
async function events(response) {
  assert.equal(response.status, 200);
  return (await response.text()).trim().split("\n").map(line => JSON.parse(line));
}

test("API isolates histories, resets only its session, and deletes capabilities", async (t) => {
  const app = await start(t);
  const requests = model(t, [answer("A"), answer("B"), answer("follow"), answer("reset"), answer("B follow")]);
  const a = await app.session();
  const b = await app.session();
  assert.notEqual(a, b);
  for (const token of [a, b, a]) await events(await app.post("prompt", { prompt: "question" }, token));
  assert.deepEqual(requests.map(request => request.messages.length), [2, 2, 4]);
  await app.post("reset", {}, a);
  for (const token of [a, b]) await events(await app.post("prompt", { prompt: "again" }, token));
  assert.deepEqual(requests.slice(3).map(request => request.messages.length), [2, 4]);
  assert.equal((await app.post("session", {}, a, {}, "DELETE")).status, 200);
  assert.equal((await app.post("prompt", { prompt: "deleted" }, a)).status, 404);
});

test("API validates origins, host, client header, tokens, JSON, content type, fields, and size", async (t) => {
  const app = await start(t);
  const token = await app.session();
  assert.equal((await app.post("sessions", {}, undefined, { Origin: "https://untrusted.example" })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = httpRequest(`${app.url}/api/sessions`, { method: "POST", headers: { Host: "untrusted.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(badHost, 403);
  assert.equal((await app.post("sessions", {}, undefined, { "X-Agent-Client": "" })).status, 403);
  assert.equal((await app.post("prompt", { prompt: "x" })).status, 401);
  assert.equal((await app.post("prompt", { prompt: "x" }, "a".repeat(64))).status, 404);
  for (const data of [null, [], { prompt: "" }, { prompt: 1 }, { prompt: "x", workspace: "/other" }, { prompt: "😀".repeat(4097) }]) {
    assert.equal((await app.post("prompt", data, token)).status, 400);
  }
  assert.equal((await app.post("prompt", { prompt: "x" }, token, { "Content-Type": "text/plain" })).status, 415);
  const malformed = await httpFetch(`${app.url}/api/prompt`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Client": "local-web" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await app.post("prompt", { prompt: "x".repeat(21_000) }, token)).status, 413);
  const preflight = await httpFetch(`${app.url}/api/prompt`, { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:5173" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:5173");
});

test("API streams running, completed, and failed tool events", async (t) => {
  const app = await start(t);
  model(t, [{ role: "assistant", content: "", tool_calls: [{ function: { name: "get_current_time", arguments: {} } }, { function: { name: "unknown", arguments: {} } }] }, answer("time")]);
  const result = await events(await app.post("prompt", { prompt: "time?" }, await app.session()));
  assert.equal(result[0].type, "running");
  assert.ok(result.some(event => event.name === "get_current_time" && event.status === "running"));
  assert.ok(result.some(event => event.name === "get_current_time" && event.status === "completed"));
  assert.ok(result.some(event => event.name === "unknown" && event.status === "failed" && event.error));
  assert.equal(result.at(-1).answer, "time");
});

test("cancellation aborts transport, blocks duplicate/reset, and preserves history", async (t) => {
  const app = await start(t, { limits: { ...webLimits, maxConcurrent: 1 } });
  const token = await app.session();
  const other = await app.session();
  let aborted = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      aborted = true;
      reject(options.signal.reason);
    }, { once: true });
  }));
  const response = await app.post("prompt", { prompt: "cancel me" }, token);
  assert.equal((await app.post("prompt", { prompt: "duplicate" }, token)).status, 409);
  assert.equal((await app.post("reset", {}, token)).status, 409);
  assert.equal((await app.post("prompt", { prompt: "busy" }, other)).status, 429);
  await app.post("cancel", {}, token);
  assert.equal((await events(response)).at(-1).type, "cancelled");
  assert.equal(aborted, true);
  const requests = model(t, [answer("next")]);
  await events(await app.post("prompt", { prompt: "next" }, token));
  assert.equal(requests[0].messages.length, 2);
});

test("server deadline releases its run slot", async (t) => {
  const app = await start(t, { limits: { ...webLimits, runMs: 25 } });
  t.mock.method(globalThis, "fetch", async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }));
  const token = await app.session();
  assert.equal((await events(await app.post("prompt", { prompt: "slow" }, token))).at(-1).code, "timeout");
  model(t, [answer("recovered")]);
  assert.equal((await events(await app.post("prompt", { prompt: "next" }, token))).at(-1).answer, "recovered");
});

test("capacity, idle expiry, absolute lifetime, and idempotent slot release are enforced", () => {
  let clock = 0;
  const store = new WebSessions(undefined, { ...webLimits, maxSessions: 2, idleMs: 10, lifetimeMs: 30, maxConcurrent: 1 }, () => clock);
  const first = store.create();
  store.create();
  assert.throws(() => store.create(), /capacity/);
  const run = store.begin(first);
  clock = 11;
  store.cleanup();
  assert.equal(run.controller.signal.aborted, true);
  assert.throws(() => store.get(first), /expired/);
  run.release();
  run.release();
  const retained = store.create();
  for (clock = 15; clock < 40; clock += 5) store.get(retained);
  clock = 41;
  assert.throws(() => store.get(retained), /expired/);
  store.close();
});

test("repository requests stay within the configured workspace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "allowed.txt"), "evidence");
  const app = await start(t, { workspace: await createWorkspace(root) });
  const requests = model(t, [{ role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "../outside" } } }, { function: { name: "read_file", arguments: { path: "allowed.txt" } } }] }, answer("allowed.txt:1")]);
  const result = await events(await app.post("prompt", { prompt: "read" }, await app.session()));
  assert.ok(result.some(event => event.status === "failed" && /workspace/.test(event.error)));
  const tools = requests[1].messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content));
  assert.equal(tools[1].content, "evidence");
});

test("production assets support a base path and reject escapes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.html"), "<h1>frontend</h1>");
  const app = await start(t, { publicDir: root, basePath: "/agent/" });
  assert.equal((await httpFetch(`${app.url}/agent/`)).status, 200);
  assert.equal((await httpFetch(`${app.url}/agent/missing.js`)).status, 404);
  assert.equal((await httpFetch(`${app.url}/outside.txt`)).status, 404);
  assert.equal((await httpFetch(`${app.url}/agent/%2e%2e%2fpackage.json`)).status, 403);
  assert.throws(() => parseOrigins(["https://example.com/path"]), /origins/);
});
