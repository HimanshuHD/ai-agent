import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseArgs } from "../dist/cli.js";

function cli(input, script = "") {
  const source = `
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      ${script}
      return Response.json({message: {role: 'assistant', content: 'answer ' + requests.length}});
    };
    await import('./dist/index.js');
    console.error('REQUESTS=' + JSON.stringify(requests));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source, "unused", "--interactive"], { input, encoding: "utf8", timeout: 5000 });
}

function requests(result) {
  return JSON.parse(result.stderr.split("REQUESTS=")[1].trim());
}

test("interactive flag allows no initial prompt and preserves one-shot parsing", () => {
  assert.deepEqual(parseArgs(["--interactive", "--workspace", "repo", "--exclude", "private"]), {
    prompt: "", interactive: true, workspacePath: "repo", excludePaths: ["private"],
  });
  assert.equal(parseArgs(["hello"]).prompt, "hello");
  assert.throws(() => parseArgs(["--interactive", "--interactive"]), /only once/);
  assert.throws(() => parseArgs(["--interactive", "hello"]), /without a prompt/);
  assert.equal(parseArgs(["--", "--interactive"]).prompt, "--interactive");
});

test("interactive CLI processes follow-ups, reset, and exit in one process", () => {
  const result = cli("first\nsecond\n/reset\nthird\n/exit\nignored\n");
  assert.equal(result.status, 0, result.stderr);
  const calls = requests(result);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.messages.length), [2, 4, 2]);
  assert.match(result.stdout, /answer 1/);
  assert.match(result.stdout, /answer 2/);
  assert.match(result.stdout, /Conversation reset/);
  assert.match(result.stdout, /Session ended/);
});

test("empty input and unknown commands do not request the model", () => {
  const result = cli("\n  \n/unknown\n/exit\n");
  assert.equal(result.status, 0);
  assert.equal(requests(result).length, 0);
  assert.match(result.stderr, /Unknown command/);
});

test("EOF completes accepted input and exits without hanging", () => {
  const result = cli("first\nsecond\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests(result).length, 2);
  assert.match(result.stdout, /Session ended/);
  assert.equal(cli("").status, 0);
});

test("a failed interactive turn reports the error and accepts the next prompt", () => {
  const result = cli("bad\ngood\n/exit\n", "if (requests.length === 1) return Response.json({message: null});");
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Turn failed: Malformed/);
  assert.equal(requests(result)[1].messages.length, 2);
  assert.match(result.stdout, /answer 2/);
});

async function interrupt(t, active) {
  const source = active
    ? `
    globalThis.fetch = async (_url, options) => {
      console.error('REQUEST_STARTED');
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        console.error('REQUEST_ABORTED'); reject(options.signal.reason);
      }, {once: true}));
    };
    await import('./dist/index.js');
  `
    : "await import('./dist/index.js');";
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, "unused", "--interactive"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  let sent = false;
  const stop = () => {
    if (!sent) {
      sent = true;
      child.kill("SIGINT");
    }
  };
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!active && stdout.includes("Interactive agent")) stop();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (active && stderr.includes("REQUEST_STARTED")) stop();
  });
  if (active) child.stdin.write("hello\n");
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Interactive interruption did not exit promptly."));
    }, 5000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
  assert.match(stdout, /Session ended/);
  if (active) assert.match(stderr, /REQUEST_ABORTED/);
}

test("Ctrl+C signal closes an idle session", { skip: process.platform === "win32" }, async t => interrupt(t, false));
test("Ctrl+C signal aborts an active model request and exits", { skip: process.platform === "win32" }, async t => interrupt(t, true));
