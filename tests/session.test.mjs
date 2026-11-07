import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspace } from "../dist/workspace.js";
import { AgentSession, sessionLimits } from "../dist/session.js";
import { runAgent } from "../dist/agent.js";

const reply = content => ({ message: { role: "assistant", content } });
const batch = count => ({ message: { role: "assistant", content: "Checking.", tool_calls: Array.from({ length: count }, () => ({ function: { name: "get_current_time", arguments: {} } })) } });
function model(t, responses) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    assert.ok(responses.length);
    return Response.json(responses.shift());
  });
  return requests;
}

test("follow-up requests include prior user prompts and final assistant answers", async (t) => {
  const requests = model(t, [reply("Your topic is Vue."), reply("Vue is the topic.")]);
  const session = new AgentSession();
  await session.run("Remember Vue");
  await session.run("What is the topic?");
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "user", content: "Remember Vue" },
    { role: "assistant", content: "Your topic is Vue." },
    { role: "user", content: "What is the topic?" },
  ]);
});

test("tool requests/results remain paired and every turn receives five fresh calls", async (t) => {
  const requests = model(t, [batch(5), reply("first"), batch(5), reply("second")]);
  const session = new AgentSession();
  await session.run("time one");
  await session.run("time two");
  assert.deepEqual(requests[1].tools, []);
  assert.equal(requests[2].tools.length, 1);
  assert.deepEqual(requests[3].tools, []);
  const history = session.getHistory();
  assert.equal(history.filter(message => message.role === "tool").length, 10);
  assert.equal(history.filter(message => message.role === "assistant" && message.tool_calls?.length).length, 2);
  assert.equal(history.at(-1).content, "second");
});

test("reset clears context while retaining an independent workspace configuration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.txt"), "allowed");
  await writeFile(path.join(root, "private.txt"), "hidden");
  const workspace = await createWorkspace(root, ["private.txt"]);
  const listing = { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "list_files", arguments: {} } }] } };
  const requests = model(t, [listing, reply("first"), listing, reply("second")]);
  const session = new AgentSession(workspace);
  workspace.root = path.join(root, "missing");
  workspace.excludePaths.push("a.txt");
  await session.run("one");
  session.reset();
  assert.equal(session.getHistory().length, 1);
  await session.run("two");
  assert.equal(requests[2].messages.length, 2);
  assert.deepEqual(requests[2].tools.map(tool => tool.function.name), ["get_current_time", "list_files", "read_file", "search_text"]);
  assert.deepEqual(JSON.parse(requests[3].messages[3].content).files, ["a.txt"]);
});

test("history eviction removes whole turns including complete tool exchanges", async (t) => {
  model(t, [batch(2), reply("old tool answer"), ...Array.from({ length: 10 }, (_, index) => reply(`answer ${index}`))]);
  const session = new AgentSession();
  await session.run("old tool prompt");
  let result;
  for (let index = 0; index < 10; index += 1) result = await session.run(`prompt ${index}`);
  assert.equal(result.droppedTurns, 1);
  const history = session.getHistory();
  assert.equal(history.filter(message => message.role === "user").length, sessionLimits.maxTurns);
  assert.ok(!history.some(message => message.role === "tool" || message.tool_calls?.length));
  assert.ok(!history.some(message => message.content.includes("old tool")));
});

test("serialized byte cap evicts older turns and can discard an oversized new turn", async (t) => {
  model(t, [reply("a".repeat(120000)), reply("b".repeat(120000)), reply("c".repeat(120000)), reply("d".repeat(300000))]);
  const session = new AgentSession();
  await session.run("one");
  await session.run("two");
  assert.equal((await session.run("three")).droppedTurns, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(session.getHistory()), "utf8") <= sessionLimits.maxHistoryBytes);
  const result = await session.run("large");
  assert.equal(result.answer.length, 300000);
  assert.equal(result.droppedTurns, 3);
  assert.equal(session.getHistory().length, 1);
});

test("failed turns do not commit partial prompts or tool exchanges", async (t) => {
  const requests = model(t, [reply("saved"), batch(1), { message: null }, reply("recovered")]);
  const session = new AgentSession();
  await session.run("keep");
  const before = session.getHistory();
  await assert.rejects(session.run("failed"), /Malformed/);
  assert.deepEqual(session.getHistory(), before);
  await session.run("next");
  assert.ok(!requests.at(-1).messages.some(message => message.content === "failed" || message.role === "tool"));
});

test("empty and oversized prompts never make model requests", async (t) => {
  const requests = model(t, [reply("ok")]);
  const session = new AgentSession();
  for (const prompt of ["", "  ", "😀".repeat(4097)]) await assert.rejects(session.run(prompt), /Prompt/);
  assert.equal(requests.length, 0);
  await session.run("😀".repeat(4096));
  assert.equal(requests.length, 1);
});

test("snapshots and separate sessions cannot mutate or share committed history", async (t) => {
  const requests = model(t, [reply("first"), reply("second"), reply("other")]);
  const first = new AgentSession();
  await first.run("one");
  first.getHistory()[1].content = "mutated";
  await first.run("two");
  await new AgentSession().run("three");
  assert.equal(requests[1].messages[1].content, "one");
  assert.equal(requests[2].messages.length, 2);
});

test("concurrent turns and reset during a run are rejected", async (t) => {
  let finish;
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => {
    finish = resolve;
  }));
  const session = new AgentSession();
  const pending = session.run("one");
  await assert.rejects(session.run("two"), /already running/);
  assert.throws(() => session.reset(), /while a turn is running/);
  finish(Response.json(reply("done")));
  await pending;
});

test("cancellation aborts transport and leaves committed history unchanged", async (t) => {
  const session = new AgentSession();
  model(t, [reply("saved")]);
  await session.run("keep");
  const before = session.getHistory();
  t.mock.method(globalThis, "fetch", async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const pending = session.run("cancelled", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(session.getHistory(), before);
  model(t, [reply("next")]);
  assert.equal((await session.run("next")).answer, "next");
});

test("active-history overflow rolls back the turn", async (t) => {
  model(t, [reply("x".repeat(1_048_576))]);
  const session = new AgentSession();
  await assert.rejects(session.run("large"), /1 MiB/);
  assert.equal(session.getHistory().length, 1);
});

test("agent execution emits tool callbacks without terminal output", async (t) => {
  model(t, [batch(1), reply("done")]);
  const log = t.mock.method(console, "log", () => {});
  const error = t.mock.method(console, "error", () => {});
  const events = [];
  await runAgent("time", undefined, { onTool: name => events.push(name) });
  assert.deepEqual(events, ["get_current_time"]);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});
