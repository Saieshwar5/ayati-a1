import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { buildSourceChunks } from "../subagents/context-extractor/chunk-builder.js";
import type { SourceChunk } from "../subagents/context-extractor/types.js";
import { extractTextWithPandoc } from "./cli/pandoc-cli.js";
import { extractTextWithTika } from "./cli/tika-cli.js";
import { inferKindFromNameOrMime, inferKindFromPath, sanitizeFileName } from "./document-ingress.js";
import type {
  ChatAttachment,
  CliChatAttachment,
  DocumentKind,
  ManagedDocumentManifest,
  ProcessedDocument,
  DocumentSegment,
  WebChatAttachment,
} from "./types.js";

interface StoredDocumentMetadata extends ManagedDocumentManifest {
  createdAt: string;
  updatedAt: string;
}

interface PreparedDocumentCache {
  version: 1;
  extractorUsed: string;
  preparedAt: string;
  document: ProcessedDocument;
  chunks: SourceChunk[];
}

export interface PreparedManagedDocument {
  manifest: ManagedDocumentManifest;
  extractorUsed: string;
  preparedAt: string;
  document: ProcessedDocument;
  chunks: SourceChunk[];
}

export interface RegisterDocumentsResult {
  documents: ManagedDocumentManifest[];
  warnings: string[];
}

export interface DocumentStoreOptions {
  dataDir?: string;
  preferCli?: boolean;
  now?: () => Date;
  maxChunkTokens?: number;
}

type ExtractionStrategy = "tika" | "pandoc" | "direct";

const PREPARED_VERSION = 1;
const DEFAULT_MAX_CHUNK_TOKENS = 700;

export class DocumentStore {
  readonly documentsDir: string;
  readonly uploadsDir: string;
  private readonly preferCli: boolean;
  private readonly nowProvider: () => Date;
  private readonly maxChunkTokens: number;

  constructor(options?: DocumentStoreOptions) {
    this.documentsDir = resolve(options?.dataDir ?? join(process.cwd(), "data", "documents"));
    this.uploadsDir = resolve(this.documentsDir, "uploads");
    this.preferCli = options?.preferCli !== false;
    this.nowProvider = options?.now ?? (() => new Date());
    this.maxChunkTokens = Math.max(250, options?.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS);
  }

  async registerAttachments(attachments: ChatAttachment[]): Promise<RegisterDocumentsResult> {
    const documents: ManagedDocumentManifest[] = [];
    const warnings: string[] = [];

    for (const attachment of attachments) {
      try {
        const manifest = attachment.source === "web"
          ? await this.registerWebAttachment(attachment)
          : await this.registerCliAttachment(attachment);
        documents.push(manifest);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(formatAttachmentError(attachment, message));
      }
    }

    return { documents, warnings };
  }

  async prepareDocuments(documents: ManagedDocumentManifest[]): Promise<PreparedManagedDocument[]> {
    const prepared: PreparedManagedDocument[] = [];
    for (const document of documents) {
      prepared.push(await this.prepareDocument(document));
    }
    return prepared;
  }

  async prepareDocument(manifest: ManagedDocumentManifest): Promise<PreparedManagedDocument> {
    const docDir = join(this.documentsDir, manifest.documentId);
    const preparedPath = join(docDir, "prepared.json");

    try {
      const raw = await readFile(preparedPath, "utf-8");
      const parsed = JSON.parse(raw) as PreparedDocumentCache;
      if (parsed && parsed.version === PREPARED_VERSION && parsed.document && Array.isArray(parsed.chunks)) {
        return {
          manifest,
          extractorUsed: parsed.extractorUsed,
          preparedAt: parsed.preparedAt,
          document: parsed.document,
          chunks: parsed.chunks,
        };
      }
    } catch {
      // Fall through to regeneration.
    }

    const built = await this.buildPreparedDocument(manifest);
    const payload: PreparedDocumentCache = {
      version: PREPARED_VERSION,
      extractorUsed: built.extractorUsed,
      preparedAt: built.preparedAt,
      document: built.document,
      chunks: built.chunks,
    };
    await mkdir(docDir, { recursive: true });
    await writeFile(preparedPath, JSON.stringify(payload, null, 2), "utf-8");
    return built;
  }

  private async buildPreparedDocument(manifest: ManagedDocumentManifest): Promise<PreparedManagedDocument> {
    const extracted = await this.extractDocument(manifest);
    const preparedAt = this.nowProvider().toISOString();

    return {
      manifest,
      extractorUsed: extracted.extractorUsed,
      preparedAt,
      document: extracted.document,
      chunks: extracted.chunks,
    };
  }

  private async extractDocument(
    manifest: ManagedDocumentManifest,
  ): Promise<Pick<PreparedManagedDocument, "extractorUsed" | "document" | "chunks">> {
    const strategies = selectExtractionStrategies(manifest.kind, this.preferCli);
    const failures: string[] = [];

    for (const strategy of strategies) {
      try {
        const text = await this.extractTextWithStrategy(manifest, strategy);
        if (text.trim().length === 0) {
          throw new Error("Extracted text was empty.");
        }

        const document = buildProcessedDocument(manifest, text, strategy);
        return {
          extractorUsed: strategy,
          document,
          chunks: buildSourceChunks([document], this.maxChunkTokens),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${strategy}: ${message}`);
      }
    }

    throw new Error(`Failed to prepare document ${manifest.name}. ${failures.join(" | ")}`);
  }

  private async extractTextWithStrategy(
    manifest: ManagedDocumentManifest,
    strategy: ExtractionStrategy,
  ): Promise<string> {
    switch (strategy) {
      case "tika":
        return extractTextWithTika({ filePath: manifest.storedPath });
      case "pandoc":
        return extractTextWithPandoc({ filePath: manifest.storedPath, to: "gfm" });
      case "direct":
        return readFile(manifest.storedPath, "utf-8");
    }
  }

  private async registerCliAttachment(attachment: CliChatAttachment): Promise<ManagedDocumentManifest> {
    const absolutePath = resolve(attachment.path);
    const displayName = attachment.name?.trim() || basename(absolutePath);
    const kind = inferKindFromPath(displayName || absolutePath);
    return this.registerFromPath({
      source: "cli",
      sourcePath: absolutePath,
      displayName,
      kind,
    });
  }

  private async registerWebAttachment(attachment: WebChatAttachment): Promise<ManagedDocumentManifest> {
    const uploadedPath = resolve(attachment.uploadedPath);
    if (!isPathInsideDirectory(this.uploadsDir, uploadedPath)) {
      throw new Error("uploaded file path is outside the managed uploads directory.");
    }

    const displayName = attachment.originalName.trim();
    if (displayName.length === 0) {
      throw new Error("uploaded file is missing an original name.");
    }

    const kind = inferKindFromNameOrMime(displayName, attachment.mimeType);
    return this.registerFromPath({
      source: "web",
      sourcePath: uploadedPath,
      displayName,
      kind,
      mimeType: attachment.mimeType,
      expectedSizeBytes: attachment.sizeBytes,
    });
  }

  private async registerFromPath(input: {
    source: "cli" | "web";
    sourcePath: string;
    displayName: string;
    kind: DocumentKind;
    mimeType?: string;
    expectedSizeBytes?: number;
  }): Promise<ManagedDocumentManifest> {
    const info = await stat(input.sourcePath);
    if (!info.isFile()) {
      throw new Error("attachment path is not a file.");
    }

    if (info.size === 0) {
      throw new Error("attachment file is empty.");
    }

    if (input.expectedSizeBytes !== undefined && input.expectedSizeBytes !== info.size) {
      throw new Error(`attachment size mismatch: expected ${input.expectedSizeBytes} bytes, found ${info.size}.`);
    }

    if (input.kind === "unknown") {
      throw new Error("unsupported attachment type.");
    }

    const bytes = await readFile(input.sourcePath);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const documentId = checksum.slice(0, 16);
    const docDir = join(this.documentsDir, documentId);
    const sourceDir = join(docDir, "source");
    const storedName = sanitizeFileName(input.displayName || basename(input.sourcePath));
    const storedPath = join(sourceDir, storedName);
    const nowIso = this.nowProvider().toISOString();

    await mkdir(sourceDir, { recursive: true });
    await copyFile(input.sourcePath, storedPath);

    const manifest: ManagedDocumentManifest = {
      documentId,
      name: storedName,
      displayName: input.displayName,
      source: input.source,
      originalPath: input.sourcePath,
      storedPath,
      kind: input.kind,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      sizeBytes: info.size,
      checksum,
    };

    const metadata: StoredDocumentMetadata = {
      ...manifest,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await writeFile(join(docDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");
    return manifest;
  }
}

function selectExtractionStrategies(kind: DocumentKind, preferCli: boolean): ExtractionStrategy[] {
  const preferred: ExtractionStrategy[] = [];

  switch (kind) {
    case "pdf":
    case "pptx":
    case "xlsx":
      preferred.push("tika");
      break;
    case "docx":
    case "html":
    case "markdown":
      preferred.push("pandoc", "tika");
      break;
    case "txt":
    case "json":
    case "csv":
      preferred.push("direct", "pandoc");
      break;
    default:
      preferred.push("tika", "pandoc");
      break;
  }

  if (!preferCli && (kind === "txt" || kind === "json" || kind === "csv" || kind === "markdown" || kind === "html")) {
    preferred.unshift("direct");
  }

  return [...new Set(preferred)];
}

function buildProcessedDocument(
  manifest: ManagedDocumentManifest,
  extractedText: string,
  extractorUsed: "tika" | "pandoc" | "direct",
): ProcessedDocument {
  const normalized = normalizeExtractedText(extractedText);
  const segments = extractorUsed === "pandoc"
    ? splitMarkdownSegments(normalized)
    : splitGenericSegments(normalized);

  return {
    id: manifest.documentId,
    name: manifest.name,
    path: manifest.originalPath,
    kind: manifest.kind,
    sizeBytes: manifest.sizeBytes,
    segments: segments.length > 0 ? segments : [{ id: "segment-1", location: "body", text: normalized }],
    warnings: [],
  };
}

function splitGenericSegments(text: string): DocumentSegment[] {
  const pages = text
    .split(/\f+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (pages.length > 1) {
    return pages.map((page, index) => ({
      id: `page-${index + 1}`,
      location: `page:${index + 1}`,
      text: page,
    }));
  }

  return text.trim().length > 0
    ? [{ id: "segment-1", location: "body", text: text.trim() }]
    : [];
}

function splitMarkdownSegments(text: string): DocumentSegment[] {
  const lines = text.split("\n");
  const segments: DocumentSegment[] = [];
  let currentHeading = "body";
  let currentLines: string[] = [];
  let index = 1;

  const flush = (): void => {
    const body = currentLines.join("\n").trim();
    if (body.length === 0) return;
    segments.push({
      id: `segment-${index}`,
      location: currentHeading,
      text: body,
    });
    index++;
    currentLines = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch?.[1]) {
      flush();
      currentHeading = `section:${headingMatch[1].trim().slice(0, 120)}`;
      continue;
    }

    currentLines.push(line);
  }

  flush();
  return segments;
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatAttachmentError(attachment: ChatAttachment, message: string): string {
  const label = attachment.source === "web" ? attachment.uploadedPath : attachment.path;
  return `${label}: ${message}`;
}

function isPathInsideDirectory(rootDir: string, targetPath: string): boolean {
  const relativePath = relative(rootDir, targetPath);
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.includes(`${sep}..${sep}`));
}
