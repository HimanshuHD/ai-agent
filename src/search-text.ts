import { readWorkspaceText, TextFileError } from "./read-file.js";
import { listFiles, listingLimits, type Workspace } from "./workspace.js";

export const searchLimits = { maxQueryLength: 200, maxFiles: 200, maxMatches: 100, maxExcerptLength: 240, maxMs: 5000 };
type SearchLimits = typeof searchLimits;

export function validateSearchQuery(query: string, maxLength = searchLimits.maxQueryLength): void {
  if (!query.trim()) throw new Error("Search query must not be empty or whitespace-only.");
  if (query.length > maxLength) throw new Error(`Search query exceeds ${maxLength} UTF-16 code units.`);
  if (query.includes("\n") || query.includes("\r") || query.includes("\0")) {
    throw new Error("Search query must be a single-line literal without NUL characters.");
  }
}

function excerpt(line: string, index: number, queryLength: number, maxLength: number) {
  let start = Math.max(0, index - Math.min(40, maxLength - queryLength));
  let end = Math.min(line.length, start + maxLength);
  // Do not return half of a UTF-16 surrogate pair at either excerpt boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start])) start += 1;
  if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1])) end -= 1;
  return { excerpt: line.slice(start, end), excerptTruncated: start > 0 || end < line.length };
}

export async function searchText(
  workspace: Workspace,
  query: string,
  directory = ".",
  limits: SearchLimits = searchLimits,
  now: () => number = () => performance.now(),
) {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Search limits must be positive safe integers.");
  }
  validateSearchQuery(query, limits.maxQueryLength);
  if (limits.maxExcerptLength < query.length) throw new Error("Excerpt limit must accommodate the query.");
  const deadline = now() + limits.maxMs;
  const isExpired = () => now() >= deadline;
  const listing = await listFiles(workspace, directory, listingLimits, isExpired);
  const reasons = new Set<string>(listing.limitReasons.map(reason => reason === "results" ? "paths" : reason));
  const errors = [...listing.errors];
  const matches: { path: string; line: number; excerpt: string; excerptTruncated: boolean }[] = [];
  let filesScanned = 0;
  let skippedBinary = 0;
  let skippedOversized = 0;

  for (const filePath of listing.files) {
    if (isExpired()) {
      reasons.add("time");
      break;
    }
    if (filesScanned >= limits.maxFiles) {
      reasons.add("files");
      break;
    }
    filesScanned += 1; // Includes failed and skipped reads to bound attempts.
    try {
      const file = await readWorkspaceText(workspace, filePath);
      if (isExpired()) {
        reasons.add("time");
        break;
      }
      const lines = file.text ? file.text.split(/\r\n|\n|\r/) : [];
      if (/\r$|\n$/.test(file.text)) lines.pop();
      for (const [index, line] of lines.entries()) {
        if (isExpired()) {
          reasons.add("time");
          break;
        }
        const position = line.indexOf(query);
        if (position === -1) continue;
        matches.push({ path: file.path, line: index + 1, ...excerpt(line, position, query.length, limits.maxExcerptLength) });
        if (matches.length >= limits.maxMatches) {
          reasons.add("matches");
          break;
        }
      }
    }
    catch (error) {
      if (error instanceof TextFileError && error.reason === "binary") skippedBinary += 1;
      else if (error instanceof TextFileError && error.reason === "size") {
        skippedOversized += 1;
        reasons.add("file_size");
      }
      else errors.push({ path: filePath, error: error instanceof Error ? error.message : "Could not read file." });
    }
    if (reasons.has("time") || reasons.has("matches")) break;
  }
  if (isExpired()) reasons.add("time");
  const incomplete = reasons.size > 0 || errors.length > 0;
  return {
    query,
    directory: listing.directory,
    caseSensitive: true,
    status: incomplete ? "incomplete" : matches.length ? "matches" : "no_matches",
    matches,
    filesScanned,
    skippedBinary,
    skippedOversized,
    truncated: reasons.size > 0,
    incomplete,
    limitReasons: [...reasons].sort(),
    errors,
  };
}
