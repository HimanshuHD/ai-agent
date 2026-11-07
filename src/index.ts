import { runAgent } from "./agent.js";
import { parseArgs } from "./cli.js";
import { createWorkspace } from "./workspace.js";

try {
  const { prompt, workspacePath, excludePaths } = parseArgs(process.argv.slice(2));
  const workspace = workspacePath === undefined ? undefined : await createWorkspace(workspacePath, excludePaths);
  console.log(await runAgent(prompt, workspace));
}
catch (error) {
  console.error("Agent run failed..!!", error);
  process.exitCode = 1;
}
