import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath, type Workspace } from "./workspace.js";

export const readingLimits = { maxFileBytes: 1_048_576, maxLines: 200, maxOutputBytes: 16_384 };
type Range = { startLine?: number; endLine?: number };

export function validateReadRange(range: Range): void {
  for (const value of [range.startLine, range.endLine]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error("Line numbers must be positive safe integers.");
    }
  }
  if (range.endLine !== undefined && range.endLine < (range.startLine ?? 1)) {
    throw new Error("endLine must be greater than or equal to startLine.");
  }
}

export async function readWorkspaceFile(workspace: Workspace, filePath: string, range: Range = {}) {
  if (!filePath.trim()) throw new Error("A nonempty workspace-relative file path is required.");
  validateReadRange(range);
  try {
    const absolute = await resolveWorkspacePath(workspace, filePath, "file");
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Requested path is not a regular file.");
      if (info.size > readingLimits.maxFileBytes) throw new Error("File exceeds the 1 MiB size limit.");
      // Read at most the limit plus one byte, even if the file grows after stat().
      const buffer = Buffer.alloc(readingLimits.maxFileBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > readingLimits.maxFileBytes) throw new Error("File exceeds the 1 MiB size limit.");
      bytes = buffer.subarray(0, offset);
    }
    finally {
      await handle.close();
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
      throw new Error("File is binary or is not valid UTF-8 text.");
    }
    if (bytes.some(byte => (byte < 32 && ![9, 10, 12, 13].includes(byte)) || byte === 127)) {
      throw new Error("File is binary or contains unsupported control characters.");
    }
    const lines = text ? text.split(/\r\n|\n|\r/) : [];
    if (/\r$|\n$/.test(text)) lines.pop();
    const startLine = range.startLine ?? 1;
    if (startLine > lines.length && !(lines.length === 0 && startLine === 1)) {
      throw new Error(`startLine exceeds the file's ${lines.length} lines.`);
    }
    const requestedEnd = Math.min(range.endLine ?? lines.length, lines.length);
    const last = Math.min(requestedEnd, startLine + readingLimits.maxLines - 1);
    const limitReasons = new Set<string>();
    if (last < requestedEnd) limitReasons.add("lines");
    const selected: string[] = [];
    let outputBytes = 0;
    let partialLastLine = false;
    for (let number = startLine; number <= last; number += 1) {
      const separatorBytes = selected.length ? 1 : 0;
      const remaining = readingLimits.maxOutputBytes - outputBytes - separatorBytes;
      if (remaining < 0) {
        limitReasons.add("text");
        break;
      }
      const line = lines[number - 1];
      const encoded = Buffer.from(line, "utf8");
      if (encoded.length > remaining) {
        // Streaming decode drops an unfinished UTF-8 character at the byte boundary.
        const prefix = new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoded.subarray(0, remaining), { stream: true });
        if (prefix.length || line.length === 0) selected.push(prefix);
        partialLastLine = prefix.length > 0;
        limitReasons.add("text");
        break;
      }
      selected.push(line);
      outputBytes += separatorBytes + encoded.length;
    }
    return {
      path: path.relative(workspace.root, absolute).split(path.sep).join("/"),
      startLine,
      endLine: startLine + selected.length - 1,
      totalLines: lines.length,
      content: selected.join("\n"),
      truncated: limitReasons.size > 0,
      limitReasons: [...limitReasons].sort(),
      partialLastLine,
    };
  }
  catch (error) {
    if (error instanceof Error && "code" in error) {
      switch (error.code) {
        case "ENOENT": throw new Error("File or parent directory does not exist.", { cause: error });
        case "EACCES":
        case "EPERM": throw new Error("File access denied.", { cause: error });
        case "ELOOP": throw new Error("Symbolic links are not allowed.", { cause: error });
        default: throw new Error("Could not access the requested workspace file.", { cause: error });
      }
    }
    throw error;
  }
}
