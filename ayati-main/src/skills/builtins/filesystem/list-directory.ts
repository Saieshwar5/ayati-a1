import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import {
  makeBlock,
  renderContextObservation,
  type ToolContextBlock,
  type ToolContextObservation,
} from "../../observations/context-observation.js";
import { resolveWorkspacePath } from "../../workspace-paths.js";
import {
  commonAnnotations,
  errorResult,
  errorResultFromUnknown,
  okResult,
  succeededContract,
  successV2,
} from "../contract-helpers.js";
import { validateListDirectoryInput } from "./validators.js";

interface EntryInfo {
  name: string;
  absolutePath: string;
  kind: "file" | "directory" | "symlink" | "other";
  depth: number;
}

interface ListAccumulator {
  entries: EntryInfo[];
  omittedCount: number;
  counts: {
    files: number;
    dirs: number;
    symlinks: number;
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
    const kind = dirent.isDirectory()
      ? "directory"
      : dirent.isFile()
        ? "file"
        : dirent.isSymbolicLink()
          ? "symlink"
          : "other";
    incrementEntryCount(acc.counts, kind);

    if (acc.entries.length < maxEntries) {
      acc.entries.push({ name: relName, absolutePath: join(dirPath, dirent.name), kind, depth });
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
      path: { type: "string", description: "Absolute path of the directory to list." },
      recursive: { type: "boolean", description: "List contents recursively (default: false)." },
      showHidden: { type: "boolean", description: "Show hidden files/directories (default: false)." },
    },
  },
  outputSchema: {
    type: "object",
    required: ["dirPath", "counts", "entries", "omittedCount", "capped", "observation"],
    properties: {
      dirPath: { type: "string" },
      counts: {
        type: "object",
        required: ["files", "dirs", "symlinks", "other"],
        properties: {
          files: { type: "integer" },
          dirs: { type: "integer" },
          symlinks: { type: "integer" },
          other: { type: "integer" },
        },
      },
      entries: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "absolutePath", "kind", "depth"],
          properties: {
            name: { type: "string" },
            absolutePath: { type: "string" },
            kind: { type: "string", enum: ["file", "directory", "symlink", "other"] },
            depth: { type: "integer" },
          },
        },
      },
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
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateListDirectoryInput(input);
    if ("ok" in parsed) return parsed;

    const dirPath = resolveWorkspacePath(parsed.path, context?.resourceScope?.rootPath);
    const maxEntries = parsed.recursive ? 400 : 200;
    const maxDepth = 8;
    const start = Date.now();

    try {
      const info = await stat(dirPath);
      if (!info.isDirectory()) {
        const actualKind = info.isFile() ? "file" : "other";
        const message = actualKind === "file"
          ? `list_directory accepts directories, but this target is a regular file: ${dirPath}. Use read_files with the same absolute path to inspect its content.`
          : `list_directory accepts directories, but this target has kind ${actualKind}: ${dirPath}. Use inspect_paths to inspect its metadata.`;
        return errorResult({
          code: "NOT_A_DIRECTORY",
          message,
          category: "semantic",
          target: dirPath,
          retryable: true,
          recoverable: true,
          suggestedNextActions: [
            actualKind === "file"
              ? `Call read_files with path=${dirPath}.`
              : `Call inspect_paths with path=${dirPath}.`,
          ],
          structuredContent: {
            requestedPath: parsed.path,
            path: dirPath,
            actualKind,
            recommendedTool: actualKind === "file" ? "read_files" : "inspect_paths",
          },
          meta: { durationMs: Date.now() - start, dirPath },
        });
      }
      const acc: ListAccumulator = {
        entries: [],
        omittedCount: 0,
        counts: { files: 0, dirs: 0, symlinks: 0, other: 0 },
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
      return errorResultFromUnknown({
        err,
        fallbackMessage: "Unknown filesystem error",
        target: dirPath,
        suggestedNextActions: [
          "Use inspect_paths to verify the exact path and kind, then retry with an accessible directory.",
        ],
        meta: { durationMs: Date.now() - start, dirPath },
      });
    }
  },
};

function incrementEntryCount(
  counts: ListAccumulator["counts"],
  kind: EntryInfo["kind"],
): void {
  if (kind === "directory") {
    counts.dirs++;
  } else if (kind === "file") {
    counts.files++;
  } else if (kind === "symlink") {
    counts.symlinks++;
  } else {
    counts.other++;
  }
}

function buildDirectoryObservation(input: {
  dirPath: string;
  recursive: boolean;
  showHidden: boolean;
  maxDepth: number;
  maxEntries: number;
  entries: EntryInfo[];
  omittedCount: number;
  counts: { files: number; dirs: number; symlinks: number; other: number };
  capped: boolean;
}): ToolContextObservation {
  const dirs = input.entries.filter((entry) => entry.kind === "directory").slice(0, 80);
  const files = input.entries.filter((entry) => entry.kind === "file").slice(0, 120);
  const symlinks = input.entries.filter((entry) => entry.kind === "symlink").slice(0, 40);
  const other = input.entries.filter((entry) => entry.kind === "other").slice(0, 40);
  const blocks = [
    dirs.length > 0 ? makeBlock({ title: "Directories", lines: dirs.map(formatEntry), maxChars: 2_000 }) : undefined,
    files.length > 0 ? makeBlock({ title: "Files", lines: files.map(formatEntry), maxChars: 3_000 }) : undefined,
    symlinks.length > 0 ? makeBlock({ title: "Symbolic links", lines: symlinks.map(formatEntry), maxChars: 1_500 }) : undefined,
    other.length > 0 ? makeBlock({ title: "Other entries", lines: other.map(formatEntry), maxChars: 1_000 }) : undefined,
  ].filter((block): block is ToolContextBlock => block !== undefined);
  return {
    mode: input.capped ? "large_ref" : "focused",
    summary: `Directory contains ${input.counts.dirs} director${input.counts.dirs === 1 ? "y" : "ies"}, ${input.counts.files} file${input.counts.files === 1 ? "" : "s"}, ${input.counts.symlinks} symbolic link${input.counts.symlinks === 1 ? "" : "s"}, and ${input.counts.other} other entr${input.counts.other === 1 ? "y" : "ies"}.`,
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
      symlinks: input.counts.symlinks,
      other: input.counts.other,
    },
    highlights: [
      `${input.counts.dirs} directories`,
      `${input.counts.files} files`,
      ...(input.counts.symlinks > 0 ? [`${input.counts.symlinks} symbolic links`] : []),
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
  return `[${entry.kind}] ${entry.absolutePath}`;
}

function formatRawEntries(entries: EntryInfo[], omittedCount: number): string {
  const lines = entries.map(formatEntry);
  if (omittedCount > 0) {
    lines.push(`...[${omittedCount} entries omitted]`);
  }
  return lines.length > 0 ? lines.join("\n") : "(empty directory)";
}
