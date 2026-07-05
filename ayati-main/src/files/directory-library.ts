import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type {
  DirectoryAttachmentEntry,
  DirectoryAttachmentRecord,
  RegisterDirectoryInput,
  RunDirectoriesManifest,
  RunDirectoryReference,
} from "./types.js";

export interface DirectoryLibraryOptions {
  dataDir: string;
  now?: () => Date;
  defaultMaxDepth?: number;
  defaultMaxFiles?: number;
}

interface ScanState {
  path: string;
  relativePath: string;
  depth: number;
}

interface DirectorySearchInput {
  directoryId: string;
  query: string;
  searchContents?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 1000;
const MAX_MANIFEST_ENTRIES = 250;
const DEFAULT_MAX_SEARCH_RESULTS = 50;
const DEFAULT_MAX_SEARCH_FILE_BYTES = 1024 * 1024;

const DEFAULT_EXCLUDES = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "data",
  "logs",
  "tmp",
  "temp",
  ".env",
  ".env.*",
  ".DS_Store",
];

export class DirectoryLibrary {
  readonly dataDir: string;
  readonly directoriesDir: string;
  readonly runAttachmentsDir: string;
  private readonly nowProvider: () => Date;
  private readonly defaultMaxDepth: number;
  private readonly defaultMaxFiles: number;

  constructor(options: DirectoryLibraryOptions) {
    this.dataDir = resolve(options.dataDir);
    this.directoriesDir = resolve(this.dataDir, "directories");
    this.runAttachmentsDir = resolve(this.dataDir, "run-attachments");
    this.nowProvider = options.now ?? (() => new Date());
    this.defaultMaxDepth = clampInt(options.defaultMaxDepth, DEFAULT_MAX_DEPTH, 0, 20);
    this.defaultMaxFiles = clampInt(options.defaultMaxFiles, DEFAULT_MAX_FILES, 1, 10_000);
  }

  async registerPath(input: RegisterDirectoryInput): Promise<DirectoryAttachmentRecord> {
    const rawPath = input.path.trim();
    if (rawPath.length === 0) {
      throw new Error("path must be a non-empty string.");
    }
    const rootPath = resolve(rawPath);

    const info = await stat(rootPath);
    if (!info.isDirectory()) {
      throw new Error(`Not a directory: ${rootPath}`);
    }

    const include = normalizePatternList(input.include);
    const exclude = normalizePatternList([...DEFAULT_EXCLUDES, ...(input.exclude ?? [])]);
    const maxDepth = clampInt(input.maxDepth, this.defaultMaxDepth, 0, 20);
    const maxFiles = clampInt(input.maxFiles, this.defaultMaxFiles, 1, 10_000);
    const directoryId = buildDirectoryId({ rootPath, include, exclude, maxDepth, maxFiles });
    const now = this.nowProvider().toISOString();

    const scan = await scanDirectory({
      rootPath,
      include,
      exclude,
      maxDepth,
      maxFiles,
    });

    const record: DirectoryAttachmentRecord = {
      directoryId,
      name: input.name?.trim() || basename(rootPath) || rootPath,
      rootPath,
      source: "cli",
      createdAt: now,
      updatedAt: now,
      ...(input.runId ? { lastUsedAt: now } : {}),
      status: scan.warnings.length > 0 || scan.truncated ? "partial" : "ready",
      capabilities: ["list", "search", "read_files", "register_files"],
      include,
      exclude,
      maxDepth,
      maxFiles,
      fileCount: scan.fileCount,
      directoryCount: scan.directoryCount,
      totalSizeBytes: scan.totalSizeBytes,
      fileTypes: scan.fileTypes,
      entries: scan.entries,
      truncated: scan.truncated,
      warnings: scan.warnings,
    };

    await mkdir(this.directoryDir(directoryId), { recursive: true });
    await writeFile(this.metadataPath(directoryId), JSON.stringify(record, null, 2), "utf-8");

    if (input.runId) {
      await this.appendRunDirectory(input.runId, {
        directoryId,
        role: "attached",
        addedAt: now,
      });
    }

    return record;
  }

  async getDirectory(directoryId: string): Promise<DirectoryAttachmentRecord> {
    const normalized = normalizeDirectoryId(directoryId);
    try {
      const raw = await readFile(this.metadataPath(normalized), "utf-8");
      return JSON.parse(raw) as DirectoryAttachmentRecord;
    } catch {
      throw new Error(`Managed directory not found: ${normalized}`);
    }
  }

  async touchRunDirectory(runId: string, directoryId: string, role: RunDirectoryReference["role"] = "used"): Promise<void> {
    const directory = await this.getDirectory(directoryId);
    const now = this.nowProvider().toISOString();
    await this.appendRunDirectory(runId, { directoryId: directory.directoryId, role, addedAt: now });
    await this.updateDirectory(directory.directoryId, { lastUsedAt: now });
  }

  async listRunDirectories(runId: string): Promise<DirectoryAttachmentRecord[]> {
    const directoryIds = await this.readRunDirectoryIds(runId);
    const directories: DirectoryAttachmentRecord[] = [];
    for (const directoryId of directoryIds) {
      try {
        directories.push(await this.getDirectory(directoryId));
      } catch {
        // Ignore stale run references.
      }
    }
    return directories;
  }

  async describeDirectory(directoryId: string): Promise<Record<string, unknown>> {
    const directory = await this.getDirectory(directoryId);
    return summarizeDirectory(directory);
  }

  async searchDirectory(input: DirectorySearchInput): Promise<Record<string, unknown>> {
    const directory = await this.getDirectory(input.directoryId);
    const query = input.query.trim();
    if (query.length === 0) {
      throw new Error("query must be a non-empty string.");
    }

    const caseSensitive = input.caseSensitive ?? false;
    const searchContents = input.searchContents ?? false;
    const maxResults = clampInt(input.maxResults, DEFAULT_MAX_SEARCH_RESULTS, 1, 500);
    const maxFileBytes = clampInt(input.maxFileBytes, DEFAULT_MAX_SEARCH_FILE_BYTES, 1024, 5 * 1024 * 1024);
    const matches: unknown[] = [];
    const errors: Array<Record<string, unknown>> = [];

    await traverseDirectory({
      rootPath: directory.rootPath,
      include: directory.include,
      exclude: directory.exclude,
      maxDepth: directory.maxDepth,
      maxFiles: directory.maxFiles,
      onEntry: async (entry) => {
        if (matches.length >= maxResults) return "stop";
        if (!searchContents || entry.kind === "directory") {
          if (matchesQuery(entry.relativePath, query, caseSensitive) || matchesQuery(entry.name, query, caseSensitive)) {
            matches.push(entry);
          }
          return;
        }

        if (entry.sizeBytes !== undefined && entry.sizeBytes > maxFileBytes) {
          return;
        }

        try {
          const content = await readFile(entry.path, "utf-8");
          if (!matchesQuery(content, query, caseSensitive)) return;
          matches.push({
            ...entry,
            lineMatches: findLineMatches(content, query, caseSensitive, 3),
          });
        } catch (err) {
          errors.push({
            path: entry.path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    return {
      directory: summarizeDirectory(directory),
      query,
      searchContents,
      caseSensitive,
      maxResults,
      matchCount: matches.length,
      capped: matches.length >= maxResults,
      matches,
      errors: errors.slice(0, 20),
    };
  }

  private directoryDir(directoryId: string): string {
    return resolve(this.directoriesDir, directoryId);
  }

  private metadataPath(directoryId: string): string {
    return resolve(this.directoryDir(directoryId), "metadata.json");
  }

  private runDirectoriesPath(runId: string): string {
    return resolve(this.runAttachmentsDir, runId, "directories.json");
  }

  private async appendRunDirectory(runId: string, reference: RunDirectoryReference): Promise<void> {
    const manifestPath = this.runDirectoriesPath(runId);
    let manifest: RunDirectoriesManifest = { runId, directories: [] };

    try {
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as RunDirectoriesManifest;
      if (parsed && parsed.runId === runId && Array.isArray(parsed.directories)) {
        manifest = parsed;
      }
    } catch {
      // Create a new manifest below.
    }

    const index = manifest.directories.findIndex((entry) => entry.directoryId === reference.directoryId);
    if (index >= 0) {
      manifest.directories[index] = reference;
    } else {
      manifest.directories.push(reference);
    }

    await mkdir(resolve(this.runAttachmentsDir, runId), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  private async readRunDirectoryIds(runId: string): Promise<string[]> {
    try {
      const raw = await readFile(this.runDirectoriesPath(runId), "utf-8");
      const parsed = JSON.parse(raw) as RunDirectoriesManifest;
      if (!parsed || !Array.isArray(parsed.directories)) {
        return [];
      }
      return parsed.directories.map((entry) => entry.directoryId).filter((directoryId) => directoryId.length > 0);
    } catch {
      return [];
    }
  }

  private async updateDirectory(
    directoryId: string,
    patch: Partial<DirectoryAttachmentRecord>,
  ): Promise<DirectoryAttachmentRecord> {
    const current = await this.getDirectory(directoryId);
    const updated: DirectoryAttachmentRecord = {
      ...current,
      ...patch,
      directoryId: current.directoryId,
      rootPath: current.rootPath,
      updatedAt: patch.updatedAt ?? this.nowProvider().toISOString(),
    };
    await writeFile(this.metadataPath(directoryId), JSON.stringify(updated, null, 2), "utf-8");
    return updated;
  }
}

export function summarizeDirectory(directory: DirectoryAttachmentRecord): Record<string, unknown> {
  return {
    directoryId: directory.directoryId,
    name: directory.name,
    rootPath: directory.rootPath,
    status: directory.status,
    capabilities: directory.capabilities,
    include: directory.include,
    exclude: directory.exclude,
    maxDepth: directory.maxDepth,
    maxFiles: directory.maxFiles,
    fileCount: directory.fileCount,
    directoryCount: directory.directoryCount,
    totalSizeBytes: directory.totalSizeBytes,
    fileTypes: directory.fileTypes,
    truncated: directory.truncated,
    warnings: directory.warnings,
    entries: directory.entries.slice(0, 50),
  };
}

async function scanDirectory(input: {
  rootPath: string;
  include: string[];
  exclude: string[];
  maxDepth: number;
  maxFiles: number;
}): Promise<{
  entries: DirectoryAttachmentEntry[];
  fileCount: number;
  directoryCount: number;
  totalSizeBytes: number;
  fileTypes: Record<string, number>;
  truncated: boolean;
  warnings: string[];
}> {
  const entries: DirectoryAttachmentEntry[] = [];
  const fileTypes: Record<string, number> = {};
  const warnings: string[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let totalSizeBytes = 0;
  let truncated = false;

  await traverseDirectory({
    ...input,
    onEntry: async (entry) => {
      if (entries.length < MAX_MANIFEST_ENTRIES) {
        entries.push(entry);
      }
      if (entry.kind === "directory") {
        directoryCount++;
        return;
      }
      fileCount++;
      totalSizeBytes += entry.sizeBytes ?? 0;
      const key = entry.extension || "(none)";
      fileTypes[key] = (fileTypes[key] ?? 0) + 1;
      if (fileCount >= input.maxFiles) {
        truncated = true;
        return "stop";
      }
    },
    onWarning: (warning) => warnings.push(warning),
  });

  return { entries, fileCount, directoryCount, totalSizeBytes, fileTypes, truncated, warnings };
}

async function traverseDirectory(input: {
  rootPath: string;
  include: string[];
  exclude: string[];
  maxDepth: number;
  maxFiles: number;
  onEntry: (entry: DirectoryAttachmentEntry) => Promise<"stop" | void>;
  onWarning?: (warning: string) => void;
}): Promise<void> {
  const queue: ScanState[] = [{ path: input.rootPath, relativePath: "", depth: 0 }];
  let visitedFiles = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    let dirents;
    try {
      dirents = await readdir(current.path, { withFileTypes: true });
    } catch (err) {
      input.onWarning?.(`${current.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      const fullPath = join(current.path, dirent.name);
      const relativePath = normalizeRelativePath(relative(input.rootPath, fullPath));
      const depth = current.depth + 1;

      if (matchesAnyPattern(relativePath, dirent.name, input.exclude)) {
        continue;
      }

      if (dirent.isSymbolicLink()) {
        input.onWarning?.(`${relativePath}: symbolic links are skipped.`);
        continue;
      }

      if (dirent.isDirectory()) {
        const entry: DirectoryAttachmentEntry = {
          path: fullPath,
          relativePath,
          name: dirent.name,
          kind: "directory",
          depth,
        };
        const result = await input.onEntry(entry);
        if (result === "stop") return;
        if (depth < input.maxDepth) {
          queue.push({ path: fullPath, relativePath, depth });
        }
        continue;
      }

      if (!dirent.isFile()) {
        continue;
      }

      if (input.include.length > 0 && !matchesAnyPattern(relativePath, dirent.name, input.include)) {
        continue;
      }

      let sizeBytes = 0;
      try {
        sizeBytes = (await stat(fullPath)).size;
      } catch (err) {
        input.onWarning?.(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
      }

      const extension = normalizeExtension(extname(dirent.name));
      const entry: DirectoryAttachmentEntry = {
        path: fullPath,
        relativePath,
        name: dirent.name,
        kind: "file",
        depth,
        sizeBytes,
        ...(extension ? { extension } : {}),
      };
      const result = await input.onEntry(entry);
      visitedFiles++;
      if (result === "stop" || visitedFiles >= input.maxFiles) return;
    }
  }
}

function buildDirectoryId(input: {
  rootPath: string;
  include: string[];
  exclude: string[];
  maxDepth: number;
  maxFiles: number;
}): string {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `dir_${hash.slice(0, 16)}`;
}

function normalizeDirectoryId(value: string): string {
  const trimmed = value.trim();
  if (!/^dir_[a-f0-9]{16}$/i.test(trimmed)) {
    throw new Error(`Invalid directoryId: ${value}`);
  }
  return trimmed;
}

function normalizePatternList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeRelativePath(value.trim());
    if (normalized.length > 0 && !out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}

function matchesAnyPattern(relativePath: string, name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(relativePath, name, pattern));
}

function matchesPattern(relativePath: string, name: string, pattern: string): boolean {
  if (pattern.startsWith("**/") && matchesPattern(relativePath, name, pattern.slice(3))) {
    return true;
  }
  if (pattern.includes("*")) {
    return globToRegExp(pattern).test(relativePath) || globToRegExp(pattern).test(name);
  }
  if (!pattern.includes("/")) {
    return name === pattern || relativePath.split("/").includes(pattern);
  }
  return relativePath === pattern || relativePath.startsWith(`${pattern}/`);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${source}$`);
}

function matchesQuery(text: string, query: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return text.includes(query);
  return text.toLowerCase().includes(query.toLowerCase());
}

function findLineMatches(
  content: string,
  query: string,
  caseSensitive: boolean,
  maxMatches: number,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length && out.length < maxMatches; index++) {
    const line = lines[index] ?? "";
    if (matchesQuery(line, query, caseSensitive)) {
      out.push({ line: index + 1, snippet: line.slice(0, 200) });
    }
  }
  return out;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeExtension(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith(".") && trimmed.length > 1 ? trimmed : undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
