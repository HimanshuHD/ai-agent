export type ToolEvent = { type: "tool"; name: string; status: "running" | "completed" | "failed"; error?: string };
export type RunEvent = ToolEvent | { type: "running" } | { type: "answer"; answer: string; droppedTurns: number }
  | { type: "error"; code: string; message: string } | { type: "cancelled" };
export type Connection = { token: string; model: string; workspaceEnabled: boolean };
const base = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
async function request(route: string, token?: string, data: unknown = {}, method = "POST", signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(`${base}/api/${route}`, { method, headers: { "Content-Type": "application/json", "X-Agent-Client": "local-web", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data), signal: signal ?? AbortSignal.timeout(20_000) });
  }
  catch {
    throw new Error("Cannot reach the local backend. Check that the web server is running.");
  }
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new Error(problem?.error?.message ?? `Request failed (HTTP ${response.status}).`);
  }
  return response;
}
export async function connect(): Promise<Connection> {
  return (await request("sessions")).json();
}
export async function reset(token: string) {
  await request("reset", token);
}
export async function cancel(token: string) {
  await request("cancel", token);
}
export async function disconnect(token: string) {
  await request("session", token, {}, "DELETE");
}
export async function run(token: string, prompt: string, onEvent: (event: RunEvent) => void, signal: AbortSignal) {
  const response = await request("prompt", token, { prompt }, "POST", signal);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The server did not return a response stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2_097_152) throw new Error("Server response exceeded the client limit.");
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const event = JSON.parse(line) as RunEvent;
        if (["answer", "error", "cancelled"].includes(event.type)) terminal = true;
        onEvent(event);
      }
    }
    if (!terminal) throw new Error("The connection ended before the run finished. Connect again if the session expired.");
  }
  finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
