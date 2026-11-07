export const usage = "Usage: npm start -- [--workspace \"path\"] [--exclude \"relative/path\"] \"Your prompt\""
  + "\n       npm start -- --interactive [--workspace \"path\"] [--exclude \"relative/path\"]";

export function parseArgs(args: string[]): {
  prompt: string;
  interactive?: true;
  workspacePath?: string;
  excludePaths: string[];
} {
  let workspacePath: string | undefined;
  let interactive = false;
  const excludePaths: string[] = [];
  const promptParts: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
    }
    else if (!optionsEnded && arg === "--interactive") {
      if (interactive) throw new Error("Specify --interactive only once.");
      interactive = true;
    }
    else if (!optionsEnded && (arg === "--workspace" || arg === "--exclude")) {
      const value = args[++index];
      if (!value?.trim() || value.startsWith("--")) {
        throw new Error(`${arg} requires a path. ${usage}`);
      }
      if (arg === "--workspace") {
        if (workspacePath !== undefined) throw new Error("Specify --workspace only once.");
        workspacePath = value;
      }
      else {
        excludePaths.push(value);
      }
    }
    else if (!optionsEnded && arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}. ${usage}`);
    }
    else {
      promptParts.push(arg);
    }
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt && !interactive) throw new Error(usage);
  if (interactive && prompt) throw new Error("Use --interactive without a prompt; enter prompts in the session.");
  if (excludePaths.length && workspacePath === undefined) {
    throw new Error("--exclude requires --workspace.");
  }
  return { prompt, workspacePath, excludePaths, ...(interactive ? { interactive: true as const } : {}) };
}
