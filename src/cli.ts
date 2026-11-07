export const usage = "Usage: npm start -- [--workspace \"path\"] [--exclude \"relative/path\"] \"Your prompt\"";

export function parseArgs(args: string[]): {
  prompt: string;
  workspacePath?: string;
  excludePaths: string[];
} {
  let workspacePath: string | undefined;
  const excludePaths: string[] = [];
  const promptParts: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
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
  if (!prompt) throw new Error(usage);
  if (excludePaths.length && workspacePath === undefined) {
    throw new Error("--exclude requires --workspace.");
  }
  return { prompt, workspacePath, excludePaths };
}
