import { extname } from "node:path";
import type { DocumentKind } from "./types.js";

const MIME_KIND_MAP = new Map<string, DocumentKind>([
  ["image/gif", "image"],
  ["image/jpeg", "image"],
  ["image/png", "image"],
  ["image/webp", "image"],
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["text/csv", "csv"],
  ["application/csv", "csv"],
  ["text/plain", "txt"],
  ["text/markdown", "markdown"],
  ["text/x-markdown", "markdown"],
  ["application/json", "json"],
  ["text/json", "json"],
  ["text/html", "html"],
]);

export function sanitizeFileName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "document";
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function inferKindFromPath(filePath: string): DocumentKind {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".gif":
    case ".jpeg":
    case ".jpg":
    case ".png":
    case ".webp":
      return "image";
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

export function inferKindFromMimeType(mimeType?: string): DocumentKind {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) {
    return "unknown";
  }

  return MIME_KIND_MAP.get(normalized) ?? "unknown";
}

export function inferKindFromNameOrMime(fileName: string, mimeType?: string): DocumentKind {
  const fromPath = inferKindFromPath(fileName);
  if (fromPath !== "unknown") {
    return fromPath;
  }

  return inferKindFromMimeType(mimeType);
}

export function isSupportedDocumentInput(fileName: string, mimeType?: string): boolean {
  return inferKindFromNameOrMime(fileName, mimeType) !== "unknown";
}

function normalizeMimeType(mimeType?: string): string | undefined {
  const trimmed = mimeType?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  const [base] = trimmed.split(";", 1);
  return base?.trim() || undefined;
}
