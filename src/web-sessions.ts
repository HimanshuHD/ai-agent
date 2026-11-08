import { randomBytes } from "node:crypto";
import { AgentSession } from "./session.js";
import type { Workspace } from "./workspace.js";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
export const webLimits = { maxSessions: 20, idleMs: 1_800_000, lifetimeMs: 7_200_000, maxConcurrent: 2, runMs: 180_000 };
type Entry = { session: AgentSession; created: number; touched: number; active?: AbortController };

export class WebSessions {
  private readonly entries = new Map<string, Entry>();
  private running = 0;
  constructor(private readonly workspace?: Workspace, readonly limits = webLimits, private readonly now = Date.now) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Web limits must be positive safe integers.");
    }
  }

  cleanup(): void {
    for (const [token, entry] of this.entries) {
      if (this.now() - entry.touched >= this.limits.idleMs || this.now() - entry.created >= this.limits.lifetimeMs) {
        entry.active?.abort();
        this.entries.delete(token);
      }
    }
  }

  create(): string {
    this.cleanup();
    if (this.entries.size >= this.limits.maxSessions) throw new HttpError(429, "session_limit", "Session capacity reached. Close a conversation or wait for expiry.");
    const token = randomBytes(32).toString("hex");
    this.entries.set(token, { session: new AgentSession(this.workspace), created: this.now(), touched: this.now() });
    return token;
  }

  get(token: string): Entry {
    this.cleanup();
    const entry = this.entries.get(token);
    if (!entry) throw new HttpError(404, "session_expired", "Session is missing or expired. Connect again to start a new conversation.");
    entry.touched = this.now();
    return entry;
  }

  begin(token: string) {
    const entry = this.get(token);
    if (entry.active) throw new HttpError(409, "run_active", "This conversation already has an active run.");
    if (this.running >= this.limits.maxConcurrent) throw new HttpError(429, "run_limit", "The local server is busy. Try again after another run finishes.");
    const controller = new AbortController();
    entry.active = controller;
    this.running += 1;
    let released = false;
    return { entry, controller, release: () => {
      if (released) return;
      released = true;
      if (entry.active === controller) entry.active = undefined;
      entry.touched = this.now();
      this.running -= 1;
    } };
  }

  reset(token: string): void {
    const entry = this.get(token);
    if (entry.active) throw new HttpError(409, "run_active", "Cancel the active run before resetting.");
    entry.session.reset();
  }

  cancel(token: string): void {
    this.get(token).active?.abort();
  }

  delete(token: string): void {
    this.get(token).active?.abort();
    this.entries.delete(token);
  }

  close(): void {
    for (const entry of this.entries.values()) entry.active?.abort();
    this.entries.clear();
  }
}
