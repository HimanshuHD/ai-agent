import { initialMessages, runTurn, type RunOptions } from "./agent.js";
import type { Message } from "./ollama.js";
import type { Workspace } from "./workspace.js";

export const sessionLimits = { maxTurns: 10, maxHistoryBytes: 262_144, maxPromptBytes: 16_384 };

export class AgentSession {
  private readonly workspace?: Workspace;
  private turns: Message[][] = [];
  private busy = false;

  constructor(workspace?: Workspace) {
    this.workspace = workspace ? structuredClone(workspace) : undefined;
  }

  getHistory(): Message[] {
    return structuredClone([...initialMessages(this.workspace), ...this.turns.flat()]);
  }

  reset(): void {
    if (this.busy) throw new Error("Cannot reset while a turn is running.");
    this.turns = [];
  }

  async run(prompt: string, options: RunOptions = {}): Promise<{ answer: string; droppedTurns: number }> {
    if (this.busy) throw new Error("A turn is already running in this session.");
    if (!prompt.trim()) throw new Error("Prompt must not be empty.");
    if (Buffer.byteLength(prompt, "utf8") > sessionLimits.maxPromptBytes) {
      throw new Error("Prompt exceeds the 16 KiB limit.");
    }
    this.busy = true;
    try {
      // Work on a copy; failures/cancellation leave committed history unchanged.
      const messages = this.getHistory();
      const start = messages.length;
      messages.push({ role: "user", content: prompt.trim() });
      const answer = await runTurn(messages, this.workspace, options);
      options.signal?.throwIfAborted();
      const turns = [...this.turns, messages.slice(start)];
      let droppedTurns = 0;
      while (turns.length > sessionLimits.maxTurns
        || Buffer.byteLength(JSON.stringify([initialMessages(this.workspace)[0], ...turns.flat()]), "utf8") > sessionLimits.maxHistoryBytes) {
        // Evict entire user turns, never individual tool requests or results.
        turns.shift();
        droppedTurns += 1;
      }
      this.turns = turns;
      return { answer, droppedTurns };
    }
    finally {
      this.busy = false;
    }
  }
}
