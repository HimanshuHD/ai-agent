import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runAgent } from "../dist/agent.js";
import { chat, parseChatResponse } from "../dist/ollama.js";

const call = (name = "get_current_time", args = {}) => ({ function: { name, arguments: args } });
const reply = (content = "", calls) => ({
  message: { role: "assistant", content, ...(calls === undefined ? {} : { tool_calls: calls }) },
});

function mockOllama(t, responses) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    assert.ok(responses.length, "unexpected extra model request");
    return Response.json(responses.shift());
  });
  return requests;
}

test("valid text and tool responses preserve content and arguments", () => {
  assert.deepEqual(parseChatResponse(reply("hello")), { role: "assistant", content: "hello" });
  const value = reply("checking", [call()]);
  assert.deepEqual(parseChatResponse(value), value.message);
});

test("malformed response structures fail descriptively", () => {
  const invalid = [null, [], 1, {}, { message: null }, { message: [] },
    { message: { role: "user", content: "x" } }, { message: { role: "assistant" } },
    reply(42), reply("", null), reply("", {}), reply("", [null]),
    reply("", [{ function: null }]), reply("", [call(42)]), reply("", [call(" ")]),
    ...[null, [], "x", 1, true, undefined].map(args => ({
      message: { role: "assistant", content: "", tool_calls: [{ function: { name: "get_current_time", arguments: args } }] },
    }))];
  for (const value of invalid) {
    assert.throws(() => parseChatResponse(value), /Malformed Ollama response/);
  }
});

test("valid text returns a trimmed answer", async (t) => {
  mockOllama(t, [reply("  answer  ")]);
  assert.equal(await runAgent("hello"), "answer");
});

test("a time call preserves the full assistant request and corresponding result", async (t) => {
  const first = reply("Let me check.", [call()]);
  const requests = mockOllama(t, [first, reply("done")]);
  await runAgent("time?");
  assert.deepEqual(requests[1].messages[2], first.message);
  const result = requests[1].messages[3];
  assert.equal(result.role, "tool");
  assert.equal(result.tool_name, "get_current_time");
  assert.ok(Number.isFinite(Date.parse(JSON.parse(result.content).utc)));
});

test("unknown tools and invalid arguments return errors without executing", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  const requests = mockOllama(t, [reply("", [call("unknown"), call("get_current_time", { timezone: "UTC" })]), reply("recovered")]);
  assert.equal(await runAgent("time"), "recovered");
  assert.match(JSON.parse(requests[1].messages[3].content).error, /Unknown tool/);
  assert.match(JSON.parse(requests[1].messages[4].content).error, /Invalid arguments/);
  assert.equal(logs.mock.callCount(), 0);
});

test("exactly five calls are allowed and tools are then omitted", async (t) => {
  t.mock.method(console, "error", () => {});
  const requests = mockOllama(t, [reply("", Array.from({ length: 5 }, () => call())), reply("done")]);
  assert.equal(await runAgent("time"), "done");
  assert.deepEqual(requests[1].tools, []);
  assert.equal(requests[1].messages.filter(message => message.role === "tool").length, 5);
});

test("an initial oversized batch executes no calls", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  mockOllama(t, [reply("", Array.from({ length: 6 }, () => call()))]);
  await assert.rejects(runAgent("time"), /limit of 5 tool calls/);
  assert.equal(logs.mock.callCount(), 0);
});

test("a later batch is rejected atomically against the remaining budget", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  mockOllama(t, [reply("", Array.from({ length: 4 }, () => call())), reply("", [call(), call()])]);
  await assert.rejects(runAgent("time"), /limit of 5 tool calls/);
  assert.equal(logs.mock.callCount(), 4);
});

test("rejected requests also exhaust the budget", async (t) => {
  const requests = mockOllama(t, [reply("", [call("unknown"), call("get_current_time", { bad: true }), call("unknown"), call("unknown"), call("unknown")]), reply("", [call()])]);
  await assert.rejects(runAgent("time"), /limit of 5 tool calls/);
  assert.deepEqual(requests[1].tools, []);
  assert.equal(requests[1].messages.filter(message => message.role === "tool").length, 5);
});

test("malformed later calls prevent the entire response from reaching execution", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  mockOllama(t, [reply("", [call(), call("get_current_time", [])])]);
  await assert.rejects(runAgent("time"), /Malformed Ollama response/);
  assert.equal(logs.mock.callCount(), 0);
});

test("empty final answers fail clearly", async (t) => {
  mockOllama(t, [reply(" \n ")]);
  await assert.rejects(runAgent("hello"), /empty answer/);
});

test("HTTP, connection, timeout, and invalid JSON errors are understandable", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(chat([]), /HTTP 503: unavailable/);
  mock.mock.mockImplementation(async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(chat([]), /Could not connect to Ollama/);
  mock.mock.mockImplementation(async () => {
    throw new DOMException("timeout", "TimeoutError");
  });
  await assert.rejects(chat([]), /timed out after 180 seconds/);
  mock.mock.mockImplementation(async () => new Response("not JSON"));
  await assert.rejects(chat([]), /could not read response JSON/);
  mock.mock.mockImplementation(async () => ({ ok: true, json: async () => {
    throw new DOMException("timeout", "AbortError");
  } }));
  await assert.rejects(chat([]), /timed out after 180 seconds/);
});

test("model configuration and request timeout are preserved", () => {
  const script = `
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.model !== 'test-model' || body.stream !== false || !(options.signal instanceof AbortSignal)) process.exit(2);
      return Response.json({message: {role: 'assistant', content: 'ok'}});
    };
    await import('./dist/index.js');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, "unused", "hello"], {
    cwd: process.cwd(), env: { ...process.env, OLLAMA_MODEL: " test-model " }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok/);
});

test("failed CLI runs exit nonzero", () => {
  for (const message of [reply(""), { message: null }]) {
    const script = `globalThis.fetch = async () => Response.json(${JSON.stringify(message)}); await import('./dist/index.js');`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, "unused", "hello"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Agent run failed/);
  }
});
