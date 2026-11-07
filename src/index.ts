import { runInteractive } from "./interactive.js";
import { runAgent } from "./agent.js";
import { parseArgs } from "./cli.js";
import { createWorkspace } from "./workspace.js";

try {
  const { prompt, workspacePath, excludePaths, interactive } = parseArgs(process.argv.slice(2));
  const workspace = workspacePath === undefined ? undefined : await createWorkspace(workspacePath, excludePaths);
  if (interactive) await runInteractive(workspace);
  else console.log(await runAgent(prompt, workspace, { onTool: name => console.error(`[tool] ${name}`) }));
}
catch (error) {
  console.error("Agent run failed..!!", error);
  process.exitCode = 1;
}
