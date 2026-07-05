import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import {
  makeBlock,
  renderContextObservation,
  type ToolContextBlock,
  type ToolContextObservation,
} from "../../observations/context-observation.js";
import { resolveWorkspacePath } from "../../workspace-paths.js";
import { commonAnnotations, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { validateListDirectoryInput } from "./validators.js";

interface EntryInfo {
  name: string;
  type: "dir" | "file" | "other";
  depth: number;
}

interface ListAccumulator {
  entries: EntryInfo[];
  omittedCount: number;
  counts: {
    files: number;
    dirs: number;
    other: number;
  };
  capped: boolean;
}

async function listEntries(
  dirPath: string,
  recursive: boolean,
  showHidden: boolean,
  maxEntries: number,
  maxDepth: number,
  depth: number,
  prefix: string,
  acc: ListAccumulator,
): Promise<void> {
  const dirents = await readdir(dirPath, { withFileTypes: true });

  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith(".")) continue;

    const relName = prefix ? join(prefix, dirent.name) : dirent.name;
    const type = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
    acc.counts[type === "dir" ? "dirs" : type === "file" ? "files" : "other"]++;

    if (acc.entries.length < maxEntries) {
      acc.entries.push({ name: relName, type, depth });
    } else {
      acc.omittedCount++;
      acc.capped = true;
    }

    if (recursive && dirent.isDirectory() && depth < maxDepth) {
      await listEntries(
        join(dirPath, dirent.name),
        true,
        showHidden,
        maxEntries,
        maxDepth,
        depth + 1,
        relName,
        acc,
      );
    }
  }
}

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "List directory contents as grouped counts plus bounded entries.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute or relative directory path." },
      recursive: { type: "boolean", description: "List contents recursively (default: false)." },
      showHidden: { type: "boolean", description: "Show hidden files/directories (default: false)." },
    },
  },
  outputSchema: {
    type: "object",
    required: ["dirPath", "counts", "entries", "omittedCount", "capped", "observation"],
    properties: {
      dirPath: { type: "string" },
      counts: { type: "object" },
      entries: { type: "array", items: { type: "object" } },
      omittedCount: { type: "integer" },
      capped: { type: "boolean" },
      observation: { type: "object" },
    },
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: true,
  }),
  observationPolicy: { outputImportance: "decision_context", rawStorage: "always", maxObservationChars: 8_000 },
  resultContract: succeededContract({
    assertions: [{
      id: "entries_present",
      kind: "json_path_exists",
      path: "$.result.structuredContent.entries",
    }],
    artifacts: [{ kind: "directory", path: "$.result.structuredContent.dirPath" }],
  }),
  selectionHints: {
    tags: ["filesystem", "directory", "list", "browse"],
    aliases: ["ls_tree", "dir_list"],
    examples: ["list folder contents", "show files in this directory"],
    domain: "filesystem",
    priority: 2,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateListDirectoryInput(input);
    if ("ok" in parsed) return parsed;

    const dirPath = resolveWorkspacePath(parsed.path);
    const maxEntries = parsed.recursive ? 400 : 200;
    const maxDepth = 8;
    const start = Date.now();

    try {
      const acc: ListAccumulator = {
        entries: [],
        omittedCount: 0,
        counts: { files: 0, dirs: 0, other: 0 },
        capped: false,
      };
      await listEntries(
        dirPath,
        parsed.recursive ?? false,
        parsed.showHidden ?? false,
        maxEntries,
        maxDepth,
        0,
        "",
        acc,
      );

      const observation = buildDirectoryObservation({
        dirPath,
        recursive: parsed.recursive === true,
        showHidden: parsed.showHidden === true,
        maxDepth,
        maxEntries,
        ...acc,
      });
      const structuredContent = {
        dirPath,
        counts: acc.counts,
        entries: acc.entries,
        omittedCount: acc.omittedCount,
        capped: acc.capped,
        recursive: parsed.recursive === true,
        showHidden: parsed.showHidden === true,
        maxDepth,
        maxEntries,
        observation,
      };
      const meta = {
        durationMs: Date.now() - start,
        dirPath,
        entryCount: acc.entries.length,
        omittedCount: acc.omittedCount,
        capped: acc.capped,
        maxDepth,
      };
      const output = renderContextObservation({
        tool: "list_directory",
        status: "success",
        message: `Listed directory: ${dirPath}`,
        observation,
      });

      return {
        ...okResult({
          output,
          meta,
          v2: successV2({
            code: "DIRECTORY_LISTED",
            message: `Listed directory: ${dirPath}`,
            structuredContent,
            artifacts: [{ kind: "directory", path: dirPath }],
            diagnostics: meta,
          }),
        }),
        rawOutput: formatRawEntries(acc.entries, acc.omittedCount),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};

function buildDirectoryObservation(input: {
  dirPath: string;
  recursive: boolean;
  showHidden: boolean;
  maxDepth: number;
  maxEntries: number;
  entries: EntryInfo[];
  omittedCount: number;
  counts: { files: number; dirs: number; other: number };
  capped: boolean;
}): ToolContextObservation {
  const dirs = input.entries.filter((entry) => entry.type === "dir").slice(0, 80);
  const files = input.entries.filter((entry) => entry.type === "file").slice(0, 120);
  const other = input.entries.filter((entry) => entry.type === "other").slice(0, 40);
  const blocks = [
    dirs.length > 0 ? makeBlock({ title: "Directories", lines: dirs.map(formatEntry), maxChars: 2_000 }) : undefined,
    files.length > 0 ? makeBlock({ title: "Files", lines: files.map(formatEntry), maxChars: 3_000 }) : undefined,
    other.length > 0 ? makeBlock({ title: "Other entries", lines: other.map(formatEntry), maxChars: 1_000 }) : undefined,
  ].filter((block): block is ToolContextBlock => block !== undefined);
  return {
    mode: input.capped ? "large_ref" : "focused",
    summary: `Directory contains ${input.counts.dirs} director${input.counts.dirs === 1 ? "y" : "ies"}, ${input.counts.files} file${input.counts.files === 1 ? "" : "s"}, and ${input.counts.other} other entr${input.counts.other === 1 ? "y" : "ies"}.`,
    stats: {
      dirPath: input.dirPath,
      recursive: input.recursive,
      showHidden: input.showHidden,
      maxDepth: input.maxDepth,
      maxEntries: input.maxEntries,
      shownEntries: input.entries.length,
      omittedCount: input.omittedCount,
      capped: input.capped,
      files: input.counts.files,
      dirs: input.counts.dirs,
      other: input.counts.other,
    },
    highlights: [
      `${input.counts.dirs} directories`,
      `${input.counts.files} files`,
      ...(input.omittedCount > 0 ? [`${input.omittedCount} entries omitted`] : []),
    ],
    blocks,
    hasMore: input.capped,
    suggestedReads: [
      { kind: "search", reason: "Use find_files or search_in_files to narrow this directory.", input: {} },
      { kind: "list_narrower", reason: "List a narrower directory or filter for a specific entry.", input: {} },
    ],
  };
}

function formatEntry(entry: EntryInfo): string {
  return `[${entry.type}] ${entry.name}`;
}

function formatRawEntries(entries: EntryInfo[], omittedCount: number): string {
  const lines = entries.map(formatEntry);
  if (omittedCount > 0) {
    lines.push(`...[${omittedCount} entries omitted]`);
  }
  return lines.length > 0 ? lines.join("\n") : "(empty directory)";
}
