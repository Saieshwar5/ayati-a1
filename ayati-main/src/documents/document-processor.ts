import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import type {
  ChatAttachment,
  DocumentKind,
  DocumentProcessingResult,
  ExtractorInput,
  DocumentExtractor,
  ProcessedDocument,
} from "./types.js";
import { PdfExtractor } from "./extractors/pdf-extractor.js";
import { DocxExtractor } from "./extractors/docx-extractor.js";
import { XlsxExtractor } from "./extractors/xlsx-extractor.js";
import { PptxExtractor } from "./extractors/pptx-extractor.js";
import { TextExtractor } from "./extractors/text-extractor.js";

const DEFAULT_MAX_ATTACHMENTS = 8;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_CHARS_PER_DOCUMENT = 180_000;
const DEFAULT_MAX_SEGMENTS_PER_DOCUMENT = 500;

export interface DocumentProcessorOptions {
  maxAttachments?: number;
  maxFileBytes?: number;
  maxCharsPerDocument?: number;
  maxSegmentsPerDocument?: number;
}

export class DocumentProcessor {
  private readonly maxAttachments: number;
  private readonly maxFileBytes: number;
  private readonly maxCharsPerDocument: number;
  private readonly maxSegmentsPerDocument: number;
  private readonly extractors: DocumentExtractor[];

  constructor(options?: DocumentProcessorOptions) {
    this.maxAttachments = options?.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
    this.maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxCharsPerDocument = options?.maxCharsPerDocument ?? DEFAULT_MAX_CHARS_PER_DOCUMENT;
    this.maxSegmentsPerDocument = options?.maxSegmentsPerDocument ?? DEFAULT_MAX_SEGMENTS_PER_DOCUMENT;
    this.extractors = [
      new PdfExtractor(),
      new DocxExtractor(),
      new XlsxExtractor(),
      new PptxExtractor(),
      new TextExtractor(),
    ];
  }

  async processAttachments(attachments: ChatAttachment[]): Promise<DocumentProcessingResult> {
    const result: DocumentProcessingResult = {
      documents: [],
      errors: [],
      totalSegments: 0,
      totalChars: 0,
    };

    const limited = attachments.slice(0, this.maxAttachments);

    for (const attachment of limited) {
      const absolutePath = resolve(attachment.path);

      try {
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) {
          result.errors.push({ path: absolutePath, message: "Attachment path is not a file." });
          continue;
        }
        if (fileStat.size > this.maxFileBytes) {
          result.errors.push({
            path: absolutePath,
            message: `File exceeds size limit (${this.maxFileBytes} bytes).`,
          });
          continue;
        }

        const bytes = await readFile(absolutePath);
        const kind = await detectDocumentKind(absolutePath, bytes);
        const extractor = this.extractors.find((entry) => entry.supports(kind));
        if (!extractor) {
          result.errors.push({ path: absolutePath, message: `Unsupported document type: ${kind}` });
          continue;
        }

        const raw = await extractor.extract({
          filePath: absolutePath,
          fileName: attachment.name?.trim() || basename(absolutePath),
          bytes,
        } satisfies ExtractorInput);

        const normalized = normalizeDocument({
          id: createDocumentId(absolutePath, bytes),
          name: attachment.name?.trim() || basename(absolutePath),
          path: absolutePath,
          kind: raw.kind,
          sizeBytes: fileStat.size,
          segments: raw.segments,
          warnings: raw.warnings ?? [],
        }, this.maxSegmentsPerDocument, this.maxCharsPerDocument);

        result.documents.push(normalized);
        result.totalSegments += normalized.segments.length;
        result.totalChars += normalized.segments.reduce((sum, entry) => sum + entry.text.length, 0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ path: absolutePath, message });
      }
    }

    if (attachments.length > this.maxAttachments) {
      result.errors.push({
        path: "attachments",
        message: `Ignored ${attachments.length - this.maxAttachments} attachment(s) due to max attachment limit.`,
      });
    }

    return result;
  }
}

function normalizeDocument(
  document: ProcessedDocument,
  maxSegmentsPerDocument: number,
  maxCharsPerDocument: number,
): ProcessedDocument {
  const warnings = [...document.warnings];
  const normalizedSegments: ProcessedDocument["segments"] = [];
  let charBudgetLeft = maxCharsPerDocument;

  for (const segment of document.segments.slice(0, maxSegmentsPerDocument)) {
    const compact = compactWhitespace(segment.text);
    if (compact.length === 0) continue;
    if (charBudgetLeft <= 0) break;

    const trimmed = compact.slice(0, Math.max(0, charBudgetLeft));
    if (trimmed.length === 0) continue;

    normalizedSegments.push({
      id: segment.id,
      location: segment.location,
      text: trimmed,
    });
    charBudgetLeft -= trimmed.length;
  }

  if (document.segments.length > maxSegmentsPerDocument) {
    warnings.push("Document had too many segments; trailing segments were ignored.");
  }
  if (charBudgetLeft <= 0) {
    warnings.push("Document text exceeded processing budget and was truncated.");
  }

  return {
    ...document,
    segments: normalizedSegments,
    warnings,
  };
}

function compactWhitespace(value: string): string {
  return value.replace(/\r/g, "\n").replace(/\t/g, " ").replace(/[ ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function detectDocumentKind(filePath: string, bytes: Buffer): Promise<DocumentKind> {
  const ext = extname(filePath).toLowerCase();
  const byExt = extensionToKind(ext);
  if (byExt !== "unknown") {
    return byExt;
  }

  const typed = await fileTypeFromBuffer(bytes);
  const mime = typed?.mime ?? "";
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (mime.startsWith("text/")) return "txt";

  return "unknown";
}

function extensionToKind(ext: string): DocumentKind {
  switch (ext) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".pptx":
      return "pptx";
    case ".xlsx":
      return "xlsx";
    case ".csv":
      return "csv";
    case ".txt":
      return "txt";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".json":
      return "json";
    case ".html":
    case ".htm":
      return "html";
    default:
      return "unknown";
  }
}

function createDocumentId(filePath: string, bytes: Buffer): string {
  return createHash("sha256").update(filePath).update(bytes).digest("hex").slice(0, 16);
}
