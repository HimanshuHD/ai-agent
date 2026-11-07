import fs from "node:fs/promises";
import path from "node:path";

export type Workspace = { root: string; excludePaths: string[] };
export const listingLimits = { maxDepth: 8, maxEntries: 10_000, maxResults: 500 };
type Limits = typeof listingLimits;
type LimitReason = "depth" | "entries" | "results";

const excludedNames = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt",
  ".output", ".cache", ".turbo", "vendor", ".venv", "venv", "__pycache__",
  ".ssh", ".aws", ".azure", ".gnupg", "secrets", "credentials",
]);

function relativeInput(input: string): string {
  // Reject both platform path syntaxes, including Windows drive-relative paths.
  if (input.includes("\0") || path.posix.isAbsolute(input) || path.win32.isAbsolute(input)
    || /^[a-z]:/i.test(input)) {
    throw new Error("Expected a workspace-relative path, not an absolute or drive path.");
  }
  const normalized = path.posix.normalize(input.replaceAll("\\", "/") || ".");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Path must remain inside the workspace.");
  }
  return normalized.replace(/\/$/, "");
}

function isExcluded(relative: string, workspace: Workspace): boolean {
  return relative.split("/").some((part) => {
    const name = part.toLowerCase();
    return excludedNames.has(name) || name === ".env" || name.startsWith(".env.")
      || /\.(pem|key|p12|pfx)$/.test(name);
  }) || workspace.excludePaths.some((excluded) => {
    const candidate = process.platform === "win32" ? relative.toLowerCase() : relative;
    const blocked = process.platform === "win32" ? excluded.toLowerCase() : excluded;
    return candidate === blocked || candidate.startsWith(`${blocked}/`);
  });
}

export async function createWorkspace(input: string, excludePaths: string[] = []): Promise<Workspace> {
  let root: string;
  try {
    root = await fs.realpath(input);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("not a directory");
    const handle = await fs.opendir(root);
    await handle.close();
  }
  catch {
    throw new Error("Invalid workspace: select an existing accessible directory.");
  }
  const excludes = excludePaths.map((value) => {
    const normalized = relativeInput(value);
    if (normalized === ".") throw new Error("An exclusion must name a path below the workspace root.");
    return normalized;
  });
  return { root, excludePaths: excludes };
}

export async function resolveWorkspacePath(workspace: Workspace, input: string, kind: "file" | "directory"): Promise<string> {
  const relative = relativeInput(input);
  if (isExcluded(relative, workspace)) throw new Error("Path is excluded from workspace access.");
  let current = workspace.root;
  // Inspect each component: realpath alone would follow links inside the workspace.
  const parts = relative === "." ? [] : relative.split("/");
  if (kind === "file" && parts.length === 0) throw new Error("Requested path is not a regular file.");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw new Error("Symbolic links and directory junctions are not allowed.");
    const expectsFile = kind === "file" && index === parts.length - 1;
    if (expectsFile ? !info.isFile() : !info.isDirectory()) {
      throw new Error(expectsFile ? "Requested path is not a regular file." : "Requested path is not a directory.");
    }
  }
  const canonical = await fs.realpath(current);
  const fromRoot = path.relative(workspace.root, canonical);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error("Path must remain inside the workspace.");
  }
  return current;
}

export async function listFiles(workspace: Workspace, directory = ".", limits: Limits = listingLimits) {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < (name === "maxDepth" ? 0 : 1)) {
      throw new Error(`Invalid listing limit: ${name}.`);
    }
  }
  const start = await resolveWorkspacePath(workspace, directory, "directory");
  const files: string[] = [];
  const reasons = new Set<LimitReason>();
  const errors: { path: string; error: string }[] = [];
  let entriesVisited = 0;
  const relativeName = (absolute: string) => path.relative(workspace.root, absolute).split(path.sep).join("/") || ".";

  async function visit(absolute: string, depth: number): Promise<void> {
    if (files.length >= limits.maxResults || entriesVisited >= limits.maxEntries) return;
    // Stream entries so reading a huge directory does not allocate an unbounded array.
    const entries: string[] = [];
    try {
      const handle = await fs.opendir(absolute);
      for await (const entry of handle) {
        if (entriesVisited >= limits.maxEntries) {
          reasons.add("entries");
          break;
        }
        entriesVisited += 1;
        entries.push(entry.name);
      }
    }
    catch {
      errors.push({ path: relativeName(absolute), error: "Could not list directory." });
      return;
    }

    entries.sort();
    for (const name of entries) {
      const fullPath = path.join(absolute, name);
      const relative = relativeName(fullPath);
      if (isExcluded(relative, workspace)) continue;
      try {
        const info = await fs.lstat(fullPath);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (depth >= limits.maxDepth) reasons.add("depth");
          else if (entriesVisited >= limits.maxEntries) reasons.add("entries");
          else await visit(fullPath, depth + 1);
        }
        else if (info.isFile()) {
          if (files.length >= limits.maxResults) {
            reasons.add("results");
            break;
          }
          files.push(relative);
        }
      }
      catch {
        errors.push({ path: relative, error: "Could not inspect entry." });
      }
      if (files.length >= limits.maxResults) {
        // Conservative: reaching the cap may leave further entries unvisited.
        reasons.add("results");
        break;
      }
    }
  }

  await visit(start, 0);
  return {
    directory: relativeName(start),
    files: files.sort(),
    entriesVisited,
    truncated: reasons.size > 0,
    limitReasons: [...reasons].sort(),
    incomplete: reasons.size > 0 || errors.length > 0,
    errors,
  };
}
