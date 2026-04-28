import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { executeSql } from "../database/sqlite-runtime.js";
import { detectFileKind, capabilitiesForKind, normalizeMimeType, sanitizeFileName } from "./file-detector.js";
import { FileMetadataStore } from "./file-metadata-store.js";
import { FileStorageLayout } from "./storage-layout.js";
import { prepareDocumentFile } from "./processors/document-processor.js";
import { prepareImageFile } from "./processors/image-processor.js";
import { prepareTableFile } from "./processors/table-processor.js";
import { prepareTextFile } from "./processors/text-processor.js";
import { prepareUnsupportedFile } from "./processors/unsupported-processor.js";
import type {
  FetchUrlInput,
  FileOrigin,
  ManagedFileRecord,
  PreparedFileRecord,
  PreparedTextChunk,
  PrepareFileOptions,
  RegisterFileInput,
  RegisterPathInput,
  RunFileReference,
} from "./types.js";

export interface FileLibraryOptions {
  dataDir: string;
  now?: () => Date;
  defaultMaxDownloadBytes?: number;
}

const DEFAULT_MAX_CHUNK_TOKENS = 700;
const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TOOL_TEXT_CHARS = 120_000;

export class FileLibrary {
  readonly layout: FileStorageLayout;
  private readonly metadataStore = new FileMetadataStore();
  private readonly nowProvider: () => Date;
  private readonly defaultMaxDownloadBytes: number;

  constructor(options: FileLibraryOptions) {
    this.layout = new FileStorageLayout(options.dataDir);
    this.nowProvider = options.now ?? (() => new Date());
    this.defaultMaxDownloadBytes = Math.max(1024, options.defaultMaxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES);
  }

  async registerUpload(input: RegisterFileInput): Promise<ManagedFileRecord> {
    return this.registerBytes(input);
  }

  async registerPath(input: RegisterPathInput): Promise<ManagedFileRecord> {
    const filePath = input.path.trim();
    if (filePath.length === 0) {
      throw new Error("path must be a non-empty string.");
    }
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    if (info.size === 0) {
      throw new Error(`File is empty: ${filePath}`);
    }
    const bytes = await readFile(filePath);
    return this.registerBytes({
      originalName: input.name?.trim() || basename(filePath),
      bytes,
      origin: input.origin ?? "local_path",
      runId: input.runId,
      runRole: input.runRole ?? (input.origin === "generated_artifact" ? "generated" : "found"),
      originalPath: filePath,
    });
  }

  async registerDownload(input: FetchUrlInput): Promise<ManagedFileRecord> {
    const url = new URL(input.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Only http and https downloads are supported.");
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}.`);
    }

    const contentLength = response.headers.get("content-length");
    const maxBytes = Math.max(1024, Math.min(input.maxBytes ?? this.defaultMaxDownloadBytes, this.defaultMaxDownloadBytes));
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      throw new Error(`download exceeds ${maxBytes} bytes.`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error(`download exceeds ${maxBytes} bytes.`);
    }

    const originalName = input.originalName?.trim()
      || basename(decodeURIComponent(url.pathname))
      || "downloaded-file";
    return this.registerBytes({
      originalName,
      bytes,
      mimeType: input.mimeType ?? response.headers.get("content-type") ?? undefined,
      origin: "agent_download",
      runId: input.runId,
      runRole: "downloaded",
      sourceUri: url.toString(),
    });
  }

  async registerArtifact(input: RegisterPathInput): Promise<ManagedFileRecord> {
    return this.registerPath({
      ...input,
      origin: "generated_artifact",
      runRole: input.runRole ?? "generated",
    });
  }

  async getFile(fileId: string): Promise<ManagedFileRecord> {
    const normalized = normalizeFileId(fileId);
    const metadata = await this.metadataStore.read(this.layout.metadataPath(normalized));
    if (!metadata) {
      throw new Error(`Managed file not found: ${normalized}`);
    }
    return metadata;
  }

  async touchRunFile(runId: string, fileId: string, role: RunFileReference["role"] = "used"): Promise<void> {
    const file = await this.getFile(fileId);
    const now = this.nowProvider().toISOString();
    await this.layout.appendRunFile(runId, { fileId: file.fileId, role, addedAt: now });
    await this.updateFile(file.fileId, { lastUsedAt: now });
  }

  async listRunFiles(runId: string): Promise<ManagedFileRecord[]> {
    const fileIds = await this.layout.readRunFileIds(runId);
    const files: ManagedFileRecord[] = [];
    for (const fileId of fileIds) {
      try {
        files.push(await this.getFile(fileId));
      } catch {
        // Ignore stale run references.
      }
    }
    return files;
  }

  async prepareFile(fileId: string, options?: PrepareFileOptions): Promise<PreparedFileRecord> {
    const file = await this.getFile(fileId);
    const textPath = this.layout.derivedPath(file.fileId, "text.json");
    const chunksPath = this.layout.derivedPath(file.fileId, "chunks.json");
    const tableProfilePath = this.layout.derivedPath(file.fileId, "table-profile.json");
    const tableDbPath = this.layout.derivedPath(file.fileId, "table.sqlite");
    const imagePath = this.layout.derivedPath(file.fileId, "image.json");
    const unsupportedPath = this.layout.derivedPath(file.fileId, "unsupported.json");

    try {
      const maxChunkTokens = Math.max(250, options?.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS);
      if (file.capabilities.includes("table")) {
        const table = await prepareTableFile({
          file,
          profilePath: tableProfilePath,
          dbPath: tableDbPath,
          sheetName: options?.sheetName,
        });
        const updated = await this.updateFile(file.fileId, {
          processingStatus: table.warnings.length > 0 ? "partial" : "ready",
          warnings: table.warnings,
        });
        return { file: updated, table };
      }

      if (file.capabilities.includes("text")) {
        const text = file.kind === "pdf" || file.kind === "docx" || file.kind === "pptx"
          ? await prepareDocumentFile({ file, outputPath: textPath, chunksPath, maxChunkTokens })
          : await prepareTextFile({ file, outputPath: textPath, chunksPath, maxChunkTokens });
        const updated = await this.updateFile(file.fileId, {
          processingStatus: text.warnings.length > 0 ? "partial" : "ready",
          warnings: text.warnings,
        });
        return { file: updated, text };
      }

      if (file.capabilities.includes("image")) {
        const image = await prepareImageFile({ file, outputPath: imagePath });
        const updated = await this.updateFile(file.fileId, {
          processingStatus: "ready",
          warnings: image.warnings,
        });
        return { file: updated, image };
      }

      const unsupported = await prepareUnsupportedFile({ file, outputPath: unsupportedPath });
      const updated = await this.updateFile(file.fileId, {
        processingStatus: "unsupported",
        warnings: unsupported.warnings,
      });
      return { file: updated };
    } catch (err) {
      const warning = err instanceof Error ? err.message : String(err);
      const updated = await this.updateFile(file.fileId, {
        processingStatus: "failed",
        warnings: [warning],
      });
      return { file: updated };
    }
  }

  async describeFile(fileId: string): Promise<Record<string, unknown>> {
    const file = await this.getFile(fileId);
    return summarizeFile(file);
  }

  async readText(fileId: string): Promise<Record<string, unknown>> {
    const prepared = await this.prepareFile(fileId);
    if (!prepared.text) {
      throw new Error(`File does not have readable text: ${prepared.file.fileId}`);
    }
    const text = prepared.text.sections.map((section) => `${section.location}\n${section.text}`).join("\n\n");
    const truncated = text.length > MAX_TOOL_TEXT_CHARS;
    return {
      file: summarizeFile(prepared.file),
      text: truncated ? `${text.slice(0, MAX_TOOL_TEXT_CHARS)}\n...[truncated]` : text,
      truncated,
      sections: prepared.text.sections.map((section) => ({ id: section.id, location: section.location })),
    };
  }

  async queryText(input: { fileId: string; query: string }): Promise<Record<string, unknown>> {
    const prepared = await this.prepareFile(input.fileId);
    if (!prepared.text) {
      throw new Error(`File does not have queryable text: ${prepared.file.fileId}`);
    }
    const matches = rankChunks(prepared.text.chunks, input.query).slice(0, 8);
    return {
      file: summarizeFile(prepared.file),
      query: input.query,
      matches,
      matchCount: matches.length,
      warnings: prepared.file.warnings,
    };
  }

  async profileTable(input: { fileId: string; sheetName?: string }): Promise<Record<string, unknown>> {
    const prepared = await this.prepareFile(input.fileId, { sheetName: input.sheetName });
    if (!prepared.table) {
      throw new Error(`File does not have table data: ${prepared.file.fileId}`);
    }
    return {
      file: summarizeFile(prepared.file),
      ...prepared.table,
    };
  }

  async queryTable(input: {
    fileId: string;
    sql: string;
    sheetName?: string;
    maxRows?: number;
  }): Promise<Record<string, unknown>> {
    const prepared = await this.prepareFile(input.fileId, { sheetName: input.sheetName });
    if (!prepared.table) {
      throw new Error(`File does not have queryable table data: ${prepared.file.fileId}`);
    }
    const result = executeSql({
      dbPath: prepared.table.dbPath,
      sql: input.sql,
      mode: "query",
      maxRows: input.maxRows,
    });
    if (!result.ok || !result.data) {
      throw new Error(result.error ?? "Failed to query file table.");
    }
    return {
      file: summarizeFile(prepared.file),
      tableName: prepared.table.tableName,
      dbPath: prepared.table.dbPath,
      columns: result.data.columns ?? [],
      rows: result.data.rows ?? [],
      rowCount: result.data.rowCount ?? 0,
      truncated: result.data.truncated ?? false,
      warnings: prepared.file.warnings,
    };
  }

  private async registerBytes(input: RegisterFileInput): Promise<ManagedFileRecord> {
    const originalName = input.originalName.trim();
    if (originalName.length === 0) {
      throw new Error("file is missing a filename.");
    }
    const bytes = Buffer.from(input.bytes);
    if (bytes.length === 0) {
      throw new Error("file is empty.");
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const fileId = `file_${sha256.slice(0, 16)}`;
    const metadataPath = this.layout.metadataPath(fileId);
    const existing = await this.metadataStore.read(metadataPath);
    const now = this.nowProvider().toISOString();
    if (existing) {
      const updated = await this.updateFile(existing.fileId, {
        updatedAt: now,
        lastUsedAt: input.runId ? now : existing.lastUsedAt,
      });
      if (input.runId) {
        await this.layout.appendRunFile(input.runId, {
          fileId,
          role: input.runRole ?? roleForOrigin(input.origin),
          addedAt: now,
        });
      }
      return updated;
    }

    const safeName = sanitizeFileName(originalName);
    await this.layout.ensureFileDirs(fileId);
    const storagePath = this.layout.originalPath(fileId, safeName);
    await writeFile(storagePath, bytes);

    const kind = detectFileKind({ fileName: originalName, mimeType: input.mimeType, bytes });
    const capabilities = capabilitiesForKind(kind);
    const record: ManagedFileRecord = {
      fileId,
      sha256,
      originalName,
      safeName,
      kind,
      ...(normalizeMimeType(input.mimeType) ? { mimeType: normalizeMimeType(input.mimeType) } : {}),
      sizeBytes: bytes.length,
      origin: input.origin,
      storagePath,
      metadataPath,
      derivedDir: this.layout.derivedDir(fileId),
      createdAt: now,
      updatedAt: now,
      ...(input.runId ? { lastUsedAt: now } : {}),
      capabilities,
      processingStatus: capabilities.includes("unsupported") ? "unsupported" : "new",
      warnings: capabilities.includes("unsupported") ? [`No extractor is available for file kind: ${kind}`] : [],
      ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
      ...(input.originalPath ? { originalPath: input.originalPath } : {}),
    };
    await this.metadataStore.write(metadataPath, record);

    if (input.runId) {
      await this.layout.appendRunFile(input.runId, {
        fileId,
        role: input.runRole ?? roleForOrigin(input.origin),
        addedAt: now,
      });
    }
    return record;
  }

  private async updateFile(
    fileId: string,
    patch: Partial<ManagedFileRecord>,
  ): Promise<ManagedFileRecord> {
    const current = await this.getFile(fileId);
    const updated: ManagedFileRecord = {
      ...current,
      ...patch,
      fileId: current.fileId,
      sha256: current.sha256,
      updatedAt: patch.updatedAt ?? this.nowProvider().toISOString(),
    };
    await this.metadataStore.write(current.metadataPath, updated);
    return updated;
  }
}

export function summarizeFile(file: ManagedFileRecord): Record<string, unknown> {
  return {
    fileId: file.fileId,
    originalName: file.originalName,
    kind: file.kind,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    origin: file.origin,
    storagePath: file.storagePath,
    capabilities: file.capabilities,
    processingStatus: file.processingStatus,
    warnings: file.warnings,
  };
}

function roleForOrigin(origin: FileOrigin): RunFileReference["role"] {
  switch (origin) {
    case "agent_download":
      return "downloaded";
    case "generated_artifact":
      return "generated";
    case "local_path":
      return "found";
    case "user_upload":
    case "telegram_upload":
      return "attached";
  }
}

function normalizeFileId(value: string): string {
  const trimmed = value.trim();
  if (!/^file_[a-f0-9]{16}$/i.test(trimmed)) {
    throw new Error(`Invalid fileId: ${value}`);
  }
  return trimmed;
}

function rankChunks(chunks: PreparedTextChunk[], query: string): Array<Record<string, unknown>> {
  const tokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length > 2);
  const ranked = chunks
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, tokens, query),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      location: entry.chunk.location,
      score: entry.score,
      text: entry.chunk.text,
    }));

  if (ranked.length > 0) {
    return ranked;
  }

  return chunks.slice(0, 4).map((chunk) => ({
    location: chunk.location,
    score: 0,
    text: chunk.text,
  }));
}

function scoreChunk(chunk: PreparedTextChunk, tokens: string[], query: string): number {
  const haystack = `${chunk.location}\n${chunk.text}`.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  let score = normalizedQuery.length >= 6 && haystack.includes(normalizedQuery) ? 10 : 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 2;
    }
  }
  return score;
}
