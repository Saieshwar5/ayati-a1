import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { formatUnixFileMode } from "../../../shared/unix-file-mode.js";
import type { ArtifactRef, ToolDefinition, ToolResult } from "../../types.js";
import {
  makeBlock,
  renderContextObservation,
  type ToolContextObservation,
} from "../../observations/context-observation.js";
import { commonAnnotations, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { resolveWorkspacePath } from "../../workspace-paths.js";
import { countFileLinesFromPath } from "./text-lines.js";
import { validateInspectPathsInput } from "./validators.js";

type PathKind = "file" | "directory" | "symlink" | "other" | "missing";
type ContentKind = "text" | "binary" | "unknown";
type RecommendedTool = "read_files" | "search_in_files" | "list_directory" | "find_files";
type RecommendedMode = "auto" | "profile" | "search" | "slice" | "full";

interface DirectoryCounts {
  files: number;
  dirs: number;
  symlinks: number;
  other: number;
}

interface ReadRecommendation {
  tool: RecommendedTool;
  mode?: RecommendedMode;
  reason: string;
}

interface InspectPathEntry {
  requestedPath: string;
  path: string;
  ok: boolean;
  exists: boolean;
  kind: PathKind;
  modeOctal?: string;
  modeSymbolic?: string;
  sizeBytes?: number;
  lineCount?: number;
  extension?: string;
  language?: string;
  contentKind?: ContentKind;
  directoryCounts?: DirectoryCounts;
  targetPath?: string;
  targetKind?: "file" | "directory" | "other" | "missing";
  targetExists?: boolean;
  targetError?: string;
  sha256?: string;
  readRecommendation?: ReadRecommendation;
  error?: string;
  code?: string;
}

const SAMPLE_BYTES = 8 * 1024;

export const inspectPathsTool: ToolDefinition = {
  name: "inspect_paths",
  description: "Inspect metadata for multiple files or directories without returning their content: existence, kind, Unix permission bits, size, line count, type, and read recommendation.",
  inputSchema: {
    type: "object",
    required: ["paths"],
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Absolute file or directory paths to inspect.",
      },
      includeLineCount: { type: "boolean", description: "Count text-file lines. Defaults to true." },
      includeHash: { type: "boolean", description: "Compute sha256 for files. Defaults to false." },
      includeDirectoryCounts: { type: "boolean", description: "Count immediate directory child kinds. Defaults to true." },
    },
  },
  outputSchema: {
    type: "object",
    required: ["results", "summary", "observation"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["requestedPath", "path", "ok", "exists", "kind"],
          properties: {
            requestedPath: { type: "string" },
            path: { type: "string" },
            ok: { type: "boolean" },
            exists: { type: "boolean" },
            kind: { type: "string" },
            modeOctal: {
              type: "string",
              description: "Four-digit Unix permission bits from lstat, such as 0644 or 4755.",
              pattern: "^[0-7]{4}$",
            },
            modeSymbolic: {
              type: "string",
              description: "Nine-character symbolic Unix permission bits, such as rw-r--r--.",
            },
            sizeBytes: { type: "integer" },
            lineCount: { type: "integer" },
            extension: { type: "string" },
            language: { type: "string" },
            contentKind: { type: "string" },
            directoryCounts: { type: "object" },
            targetPath: { type: "string" },
            targetKind: {
              type: "string",
              enum: ["file", "directory", "other", "missing"],
            },
            targetExists: { type: "boolean" },
            targetError: { type: "string" },
            sha256: { type: "string" },
            readRecommendation: { type: "object" },
            error: { type: "string" },
            code: { type: "string" },
          },
        },
      },
      summary: { type: "object" },
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
      id: "inspect_paths_results_present",
      kind: "json_path_exists",
      path: "$.result.structuredContent.results",
    }],
  }),
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateInspectPathsInput(input);
    if ("ok" in parsed) return parsed;

    const start = Date.now();
    const includeLineCount = parsed.includeLineCount ?? true;
    const includeHash = parsed.includeHash ?? false;
    const includeDirectoryCounts = parsed.includeDirectoryCounts ?? true;
    const results: InspectPathEntry[] = [];

    for (const requestedPath of parsed.paths) {
      results.push(await inspectOnePath({
        requestedPath,
        includeLineCount,
        includeHash,
        includeDirectoryCounts,
        rootPath: context?.resourceScope?.rootPath,
      }));
    }

    const summary = buildSummary(results);
    const observation = buildObservation(results, summary);
    const output = renderContextObservation({
      tool: "inspect_paths",
      status: "success",
      message: `Inspected metadata for ${results.length} path${results.length === 1 ? "" : "s"}.`,
      observation,
    });
    const meta = {
      durationMs: Date.now() - start,
      requested: summary.requested,
      found: summary.found,
      missing: summary.missing,
      files: summary.files,
      directories: summary.directories,
      symlinks: summary.symlinks,
    };
    const structuredContent = {
      results,
      summary,
      observation,
    };
    const artifacts: ArtifactRef[] = results.flatMap((entry): ArtifactRef[] => {
      if (!entry.exists || (entry.kind !== "file" && entry.kind !== "directory")) {
        return [];
      }
      return [{ kind: entry.kind, path: entry.path }];
    });

    return {
      ...okResult({
        output,
        meta,
        v2: successV2({
          code: "PATHS_INSPECTED",
          message: `Inspected metadata for ${results.length} path${results.length === 1 ? "" : "s"}.`,
          structuredContent,
          artifacts,
          diagnostics: meta,
        }),
      }),
      rawOutput: formatRawOutput(results, summary),
    };
  },
};

async function inspectOnePath(input: {
  requestedPath: string;
  includeLineCount: boolean;
  includeHash: boolean;
  includeDirectoryCounts: boolean;
  rootPath?: string;
}): Promise<InspectPathEntry> {
  const path = resolveWorkspacePath(input.requestedPath, input.rootPath);
  try {
    const info = await lstat(path);
    const unixMode = formatUnixFileMode(info.mode);
    if (info.isDirectory()) {
      const directoryCounts = input.includeDirectoryCounts ? await countDirectoryChildren(path) : undefined;
      return compactEntry({
        requestedPath: input.requestedPath,
        path,
        ok: true,
        exists: true,
        kind: "directory",
        ...unixMode,
        directoryCounts,
        readRecommendation: {
          tool: "list_directory",
          reason: "Path is a directory; list it or search within it before reading file content.",
        },
      });
    }

    if (info.isSymbolicLink()) {
      const target = await inspectSymlinkTarget(path);
      return compactEntry({
        requestedPath: input.requestedPath,
        path,
        ok: true,
        exists: true,
        kind: "symlink",
        ...unixMode,
        sizeBytes: info.size,
        ...target,
        readRecommendation: recommendSymlinkTarget(target),
      });
    }

    if (!info.isFile()) {
      return compactEntry({
        requestedPath: input.requestedPath,
        path,
        ok: true,
        exists: true,
        kind: "other",
        ...unixMode,
        sizeBytes: info.size,
        readRecommendation: {
          tool: "find_files",
          reason: "Path is not a regular file, directory, or symbolic link; locate a supported path before reading.",
        },
      });
    }

    const extension = extname(path).toLowerCase();
    const language = inferLanguage(path);
    const contentKind = await detectContentKind(path);
    const lineCount = input.includeLineCount && contentKind === "text"
      ? await countFileLinesFromPath(path)
      : undefined;
    const sha256 = input.includeHash ? await hashFile(path) : undefined;
    return compactEntry({
      requestedPath: input.requestedPath,
      path,
      ok: true,
      exists: true,
      kind: "file",
      ...unixMode,
      sizeBytes: info.size,
      ...(lineCount !== undefined ? { lineCount } : {}),
      ...(extension ? { extension } : {}),
      language,
      contentKind,
      ...(sha256 ? { sha256 } : {}),
      readRecommendation: recommendFileRead(info.size, contentKind, parsedLineCount(lineCount)),
    });
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : undefined;
    const message = err instanceof Error ? err.message : "Unknown filesystem error";
    return compactEntry({
      requestedPath: input.requestedPath,
      path,
      ok: false,
      exists: false,
      kind: "missing",
      error: message,
      ...(code ? { code } : {}),
      readRecommendation: {
        tool: "find_files",
        reason: "Path was not found; search by filename or nearby directory before reading.",
      },
    });
  }
}

async function detectContentKind(path: string): Promise<ContentKind> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const result = await handle.read(buffer, 0, SAMPLE_BYTES, 0);
    if (result.bytesRead === 0) {
      return "text";
    }
    const sample = buffer.subarray(0, result.bytesRead);
    if (sample.includes(0)) {
      return "binary";
    }
    const controlBytes = sample.filter((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13);
    return controlBytes.length > Math.max(4, sample.length * 0.02) ? "binary" : "text";
  } catch {
    return "unknown";
  } finally {
    await handle?.close();
  }
}

async function countDirectoryChildren(path: string): Promise<DirectoryCounts> {
  const counts: DirectoryCounts = { files: 0, dirs: 0, symlinks: 0, other: 0 };
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      counts.dirs++;
    } else if (entry.isFile()) {
      counts.files++;
    } else if (entry.isSymbolicLink()) {
      counts.symlinks++;
    } else {
      counts.other++;
    }
  }
  return counts;
}

async function inspectSymlinkTarget(path: string): Promise<Pick<
  InspectPathEntry,
  "targetPath" | "targetKind" | "targetExists" | "targetError"
>> {
  const linkTarget = await readlink(path);
  const lexicalTargetPath = resolve(dirname(path), linkTarget);
  try {
    const [targetPath, targetInfo] = await Promise.all([
      realpath(path),
      stat(path),
    ]);
    return {
      targetPath,
      targetKind: kindFromStats(targetInfo),
      targetExists: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown symbolic-link target error";
    if (isMissingFilesystemError(err)) {
      return {
        targetPath: lexicalTargetPath,
        targetKind: "missing",
        targetExists: false,
      };
    }
    return {
      targetPath: lexicalTargetPath,
      targetError: message,
    };
  }
}

function kindFromStats(info: Stats): "file" | "directory" | "other" {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  return "other";
}

function isMissingFilesystemError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  const code = String((err as { code?: unknown }).code);
  return code === "ENOENT" || code === "ENOTDIR";
}

function recommendSymlinkTarget(
  target: Pick<InspectPathEntry, "targetPath" | "targetKind" | "targetExists" | "targetError">,
): ReadRecommendation {
  if (target.targetExists && target.targetKind === "file") {
    return {
      tool: "read_files",
      mode: "auto",
      reason: "The symbolic link resolves to a regular file. A content read will still validate the resolved target against read policy.",
    };
  }
  if (target.targetExists && target.targetKind === "directory") {
    return {
      tool: "list_directory",
      reason: "The symbolic link resolves to a directory. Listing will still validate the resolved target against read policy.",
    };
  }
  if (target.targetKind === "missing") {
    return {
      tool: "find_files",
      reason: "The symbolic link target is missing; locate the intended file or directory before reading.",
    };
  }
  return {
    tool: "find_files",
    reason: target.targetError
      ? "The symbolic link target could not be inspected; locate or inspect an accessible target before reading."
      : "The symbolic link resolves to an unsupported path kind; locate a regular file or directory before reading.",
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function recommendFileRead(sizeBytes: number, contentKind: ContentKind, lineCount?: number): ReadRecommendation {
  if (contentKind === "binary") {
    return {
      tool: "find_files",
      reason: "File appears binary; avoid text read tools unless a text extractor exists for this file type.",
    };
  }
  if (sizeBytes <= 80_000 && (lineCount === undefined || lineCount <= 1_200)) {
    return {
      tool: "read_files",
      mode: "auto",
      reason: "File is small enough for a normal bounded batch read.",
    };
  }
  if (sizeBytes <= 1_000_000) {
    return {
      tool: "read_files",
      mode: "profile",
      reason: "File is medium-sized; inspect profile or search before reading exact slices.",
    };
  }
  return {
    tool: "search_in_files",
    mode: "search",
    reason: "File is large; search for relevant symbols or read exact slices instead of broad content.",
  };
}

function buildSummary(results: InspectPathEntry[]): {
  requested: number;
  found: number;
  missing: number;
  files: number;
  directories: number;
  symlinks: number;
  other: number;
  textFiles: number;
  binaryFiles: number;
  totalSizeBytes: number;
} {
  return {
    requested: results.length,
    found: results.filter((entry) => entry.exists).length,
    missing: results.filter((entry) => !entry.exists).length,
    files: results.filter((entry) => entry.kind === "file").length,
    directories: results.filter((entry) => entry.kind === "directory").length,
    symlinks: results.filter((entry) => entry.kind === "symlink").length,
    other: results.filter((entry) => entry.kind === "other").length,
    textFiles: results.filter((entry) => entry.contentKind === "text").length,
    binaryFiles: results.filter((entry) => entry.contentKind === "binary").length,
    totalSizeBytes: results.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0),
  };
}

function buildObservation(results: InspectPathEntry[], summary: ReturnType<typeof buildSummary>): ToolContextObservation {
  const files = results.filter((entry) => entry.kind === "file");
  const directories = results.filter((entry) => entry.kind === "directory");
  const symlinks = results.filter((entry) => entry.kind === "symlink");
  const missing = results.filter((entry) => !entry.exists);
  return {
    mode: "focused",
    summary: `Found ${summary.found}/${summary.requested} path${summary.requested === 1 ? "" : "s"}: ${summary.files} file${summary.files === 1 ? "" : "s"}, ${summary.directories} director${summary.directories === 1 ? "y" : "ies"}, ${summary.symlinks} symbolic link${summary.symlinks === 1 ? "" : "s"}, ${summary.missing} missing.`,
    stats: summary,
    highlights: [
      `${summary.files} files`,
      `${summary.directories} directories`,
      ...(summary.symlinks > 0 ? [`${summary.symlinks} symbolic links`] : []),
      ...(summary.missing > 0 ? [`${summary.missing} missing`] : []),
      `${summary.totalSizeBytes} total bytes`,
    ],
    blocks: [
      files.length > 0 ? makeBlock({
        title: "Files",
        lines: files.map(formatEntryLine),
        maxChars: 4_000,
      }) : undefined,
      directories.length > 0 ? makeBlock({
        title: "Directories",
        lines: directories.map(formatEntryLine),
        maxChars: 2_000,
      }) : undefined,
      symlinks.length > 0 ? makeBlock({
        title: "Symbolic links",
        lines: symlinks.map(formatEntryLine),
        maxChars: 2_000,
      }) : undefined,
      missing.length > 0 ? makeBlock({
        title: "Missing",
        lines: missing.map(formatEntryLine),
        maxChars: 1_500,
      }) : undefined,
    ].filter((block): block is NonNullable<typeof block> => block !== undefined),
    hasMore: false,
    suggestedReads: [
      { kind: "search", reason: "Search inside roots or files when metadata shows large files.", input: {} },
      { kind: "read_range", reason: "Read exact slices after metadata identifies a manageable target.", input: {} },
    ],
  };
}

function formatEntryLine(entry: InspectPathEntry): string {
  const parts = [
    entry.path,
    entry.kind,
    entry.modeOctal && entry.modeSymbolic
      ? `mode=${entry.modeOctal} (${entry.modeSymbolic})`
      : "",
    entry.sizeBytes !== undefined ? `${entry.sizeBytes} bytes` : "",
    entry.lineCount !== undefined ? `${entry.lineCount} lines` : "",
    entry.sha256 ? `sha256=${entry.sha256}` : "",
    entry.language ? entry.language : "",
    entry.contentKind ? entry.contentKind : "",
    entry.directoryCounts ? `${entry.directoryCounts.dirs} dirs/${entry.directoryCounts.files} files` : "",
    entry.targetPath ? `target=${entry.targetPath}` : "",
    entry.targetKind ? `targetKind=${entry.targetKind}` : "",
    entry.targetExists !== undefined ? `targetExists=${entry.targetExists}` : "",
    entry.targetError ? `targetError=${entry.targetError}` : "",
    entry.readRecommendation ? `recommend ${entry.readRecommendation.tool}${entry.readRecommendation.mode ? `:${entry.readRecommendation.mode}` : ""}` : "",
    entry.error ? `error=${entry.error}` : "",
  ];
  return parts.filter((part) => part.length > 0).join(" | ");
}

function formatRawOutput(results: InspectPathEntry[], summary: ReturnType<typeof buildSummary>): string {
  return [
    "# inspect_paths",
    "",
    "## Summary",
    JSON.stringify(summary, null, 2),
    "",
    "## Results",
    ...results.map((entry) => JSON.stringify(entry, null, 2)),
  ].join("\n");
}

function inferLanguage(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript-react",
    ".js": "javascript",
    ".jsx": "javascript-react",
    ".json": "json",
    ".md": "markdown",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".css": "css",
    ".html": "html",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".txt": "text",
  };
  return map[ext] ?? (ext ? ext.slice(1) : "text");
}

function parsedLineCount(lineCount: number | undefined): number | undefined {
  return Number.isFinite(lineCount) ? lineCount : undefined;
}

function compactEntry(entry: InspectPathEntry): InspectPathEntry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as InspectPathEntry;
}
