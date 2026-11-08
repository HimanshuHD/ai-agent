import { createWebServer, parseOrigins } from "./web-server.js";
import { createWorkspace } from "./workspace.js";

try {
  const workspace = process.env.AGENT_WORKSPACE
    ? await createWorkspace(process.env.AGENT_WORKSPACE, (process.env.AGENT_EXCLUDE ?? "").split(",").filter(Boolean))
    : undefined;
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
  const allowedOrigins = process.env.WEB_ALLOWED_ORIGINS ? parseOrigins(process.env.WEB_ALLOWED_ORIGINS.split(",").map(value => value.trim())) : undefined;
  const { server, sessions } = createWebServer({ workspace, allowedOrigins, basePath: process.env.WEB_BASE_PATH });
  server.on("error", (error) => {
    console.error("Web server failed:", error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`Local agent: http://127.0.0.1:${port}${process.env.WEB_BASE_PATH ?? "/"}`));
  const stop = () => {
    sessions.close();
    server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
catch (error) {
  console.error("Web startup failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
