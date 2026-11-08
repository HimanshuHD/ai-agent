import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AgentSession } from "./session.js";
import type { Workspace } from "./workspace.js";

export async function runInteractive(workspace?: Workspace, io: {
  input: Readable;
  output: Writable;
  error: Writable;
} = { input: process.stdin, output: process.stdout, error: process.stderr }): Promise<void> {
  const session = new AgentSession(workspace);
  const terminal = io.input === process.stdin && Boolean(process.stdin.isTTY);
  const reader = createInterface({ input: io.input, output: io.output, terminal });
  let stopped = false;
  let active: AbortController | undefined;
  const stop = () => {
    stopped = true;
    active?.abort();
    reader.close();
  };
  reader.on("SIGINT", stop);
  process.on("SIGINT", stop);
  io.output.write("Interactive agent. Commands: /reset, /exit. Ctrl+C exits.\n");
  const prompt = () => {
    if (terminal && !stopped) {
      reader.setPrompt("> ");
      reader.prompt();
    }
  };
  prompt();
  try {
    for await (const input of reader) {
      if (stopped) break;
      const line = input.trim();
      if (!line) {
        prompt();
        continue;
      }
      if (line === "/exit") break;
      if (line === "/reset") {
        session.reset();
        io.output.write("Conversation reset; workspace retained.\n");
      }
      else if (line.startsWith("/")) {
        io.error.write("Unknown command. Use /reset or /exit.\n");
      }
      else {
        active = new AbortController();
        try {
          const result = await session.run(line, {
            signal: active.signal,
            onEvent: (event) => {
              if (event.status === "running") io.error.write(`[tool] ${event.name}\n`);
            },
          });
          if (!stopped) {
            io.output.write(`${result.answer}\n`);
            if (result.droppedTurns) {
              io.error.write(`[history] Dropped ${result.droppedTurns} complete turn(s) to stay within session limits.\n`);
            }
          }
        }
        catch (error) {
          if (!stopped) io.error.write(`Turn failed: ${error instanceof Error ? error.message : "Unknown error"}\n`);
        }
        finally {
          active = undefined;
        }
      }
      prompt();
    }
  }
  finally {
    stopped = true;
    active?.abort();
    reader.close();
    reader.off("SIGINT", stop);
    process.off("SIGINT", stop);
    io.output.write("Session ended.\n");
  }
}
