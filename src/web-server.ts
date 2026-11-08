import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isObject } from "./ollama.js";
import { sessionLimits } from "./session.js";
import { HttpError, WebSessions, webLimits } from "./web-sessions.js";
import type { Workspace } from "./workspace.js";

export function parseOrigins(values: string[]): string[] {
  return values.map((value) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value || url.username || url.password) {
      throw new Error("Allowed origins must be exact HTTP(S) origins without paths or credentials.");
    }
    return value;
  });
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415, "content_type", "Use application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 20_480) {
      request.resume();
      throw new HttpError(413, "body_limit", "Request body exceeds 20 KiB.");
    }
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  catch {
    throw new HttpError(400, "invalid_json", "Request body must contain valid JSON.");
  }
  if (!isObject(value)) throw new HttpError(400, "invalid_body", "Request body must be an object.");
  return value;
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export function createWebServer(options: {
  workspace?: Workspace; allowedOrigins?: string[]; publicDir?: string; basePath?: string;
  limits?: typeof webLimits; now?: () => number;
} = {}) {
  const sessions = new WebSessions(options.workspace, options.limits, options.now);
  const origins = parseOrigins(options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"]);
  const publicDir = path.resolve(options.publicDir ?? fileURLToPath(new URL("../web-dist/", import.meta.url)));
  const base = options.basePath ?? "/";
  if (!/^\/(?:[\w-]+\/)*$/.test(base)) throw new Error("Web base path must start and end with / and contain simple path segments.");
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host ?? "")) throw new HttpError(403, "host", "Host is not permitted.");
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname.startsWith("/api/")) {
        const origin = request.headers.origin;
        if (origin && ![...origins, ...hosts.map(host => `http://${host}`)].includes(origin)) throw new HttpError(403, "origin", "Browser origin is not permitted.");
        if (origin) {
          response.setHeader("Access-Control-Allow-Origin", origin);
          response.setHeader("Vary", "Origin");
        }
        if (request.method === "OPTIONS") {
          response.writeHead(204, { "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Agent-Client", "Access-Control-Max-Age": "600" });
          response.end();
          return;
        }
        if (request.headers["x-agent-client"] !== "local-web") throw new HttpError(403, "client_header", "The local-web client header is required.");
        const validRoute = (request.method === "POST" && ["/api/sessions", "/api/prompt", "/api/reset", "/api/cancel"].includes(pathname))
          || (request.method === "DELETE" && pathname === "/api/session");
        if (!validRoute) throw new HttpError(404, "route", "API route not found.");
        const data = await body(request);
        if (Object.keys(data).some(key => pathname !== "/api/prompt" || key !== "prompt")) throw new HttpError(400, "arguments", "Unexpected request fields.");
        if (pathname === "/api/sessions") {
          json(response, 201, { token: sessions.create(), model: process.env.OLLAMA_MODEL?.trim() || "qwen3:1.7b", workspaceEnabled: Boolean(options.workspace), limits: { ...sessionLimits, ...sessions.limits } });
          return;
        }
        const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? "");
        if (!match) throw new HttpError(401, "session_token", "A valid session token is required.");
        const token = match[1];
        if (pathname === "/api/reset") sessions.reset(token);
        else if (pathname === "/api/cancel") sessions.cancel(token);
        else if (pathname === "/api/session") sessions.delete(token);
        else {
          const prompt = data.prompt;
          if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt, "utf8") > sessionLimits.maxPromptBytes) throw new HttpError(400, "prompt", "Prompt must be nonempty text of at most 16 KiB UTF-8.");
          const run = sessions.begin(token);
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            run.controller.abort();
          }, sessions.limits.runMs);
          timer.unref();
          const disconnected = () => {
            if (!response.writableEnded) run.controller.abort();
          };
          response.on("close", disconnected);
          response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
          const emit = (event: unknown) => {
            if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
          };
          emit({ type: "running" });
          try {
            emit({ type: "answer", ...await run.entry.session.run(prompt, { signal: run.controller.signal, onEvent: emit }) });
          }
          catch (error) {
            if (timedOut) emit({ type: "error", code: "timeout", message: `Run exceeded the ${Math.ceil(sessions.limits.runMs / 1000)}-second server deadline.` });
            else if (run.controller.signal.aborted) emit({ type: "cancelled" });
            else emit({ type: "error", code: "run_failed", message: error instanceof Error ? error.message : "Agent run failed." });
          }
          finally {
            clearTimeout(timer);
            response.off("close", disconnected);
            run.release();
            response.end();
          }
          return;
        }
        json(response, 200, { ok: true });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method", "Method not allowed.");
      if (!pathname.startsWith(base)) throw new HttpError(404, "route", "Page not found.");
      const relative = decodeURIComponent(pathname.slice(base.length));
      const target = path.resolve(publicDir, relative || "index.html");
      if (target !== publicDir && !target.startsWith(`${publicDir}${path.sep}`)) throw new HttpError(403, "path", "Path is not permitted.");
      let file = target;
      let content: Buffer;
      try {
        content = await readFile(file);
      }
      catch {
        if (path.extname(relative)) throw new HttpError(404, "asset", "Asset not found.");
        file = path.join(publicDir, "index.html");
        try {
          content = await readFile(file);
        }
        catch {
          throw new HttpError(503, "frontend", "Frontend is not built. Run npm run build.");
        }
      }
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; base-uri 'none'; frame-ancestors 'none'" });
      response.end(request.method === "HEAD" ? undefined : content);
    }
    catch (error) {
      if (response.headersSent) response.end();
      else {
        const problem = error instanceof HttpError ? error : new HttpError(500, "server", "The local server could not complete the request.");
        response.setHeader("Connection", "close");
        json(response, problem.status, { error: { code: problem.code, message: problem.message } });
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const cleanup = setInterval(() => sessions.cleanup(), 30_000);
  cleanup.unref();
  server.on("close", () => {
    clearInterval(cleanup);
    sessions.close();
  });
  return { server, sessions };
}
