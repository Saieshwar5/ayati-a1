import { extname } from "node:path";
import type { FileCapability, FileKind } from "./types.js";

const MIME_KIND_MAP = new Map<string, FileKind>([
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
  if (trimmed.length === 0) return "file";
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function inferKindFromName(fileName: string): FileKind {
  switch (extname(fileName).toLowerCase()) {
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

export function inferKindFromMimeType(mimeType?: string): FileKind {
  const normalized = normalizeMimeType(mimeType);
  return normalized ? MIME_KIND_MAP.get(normalized) ?? "unknown" : "unknown";
}

export function detectFileKind(input: {
  fileName: string;
  mimeType?: string;
  bytes?: Uint8Array;
}): FileKind {
  const signatureKind = input.bytes ? inferKindFromSignature(input.bytes) : "unknown";
  if (signatureKind !== "unknown") {
    return signatureKind;
  }

  const nameKind = inferKindFromName(input.fileName);
  if (nameKind !== "unknown") {
    return nameKind;
  }

  return inferKindFromMimeType(input.mimeType);
}

export function capabilitiesForKind(kind: FileKind): FileCapability[] {
  switch (kind) {
    case "csv":
    case "xlsx":
      return ["table"];
    case "txt":
    case "markdown":
    case "html":
    case "json":
    case "pdf":
    case "docx":
    case "pptx":
      return ["text"];
    case "image":
      return ["image", "ocr_candidate"];
    default:
      return ["unsupported"];
  }
}

export function normalizeMimeType(mimeType?: string): string | undefined {
  const trimmed = mimeType?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.split(";")[0]?.trim() || undefined;
}

function inferKindFromSignature(bytes: Uint8Array): FileKind {
  const head = Buffer.from(bytes.slice(0, 16));
  const ascii = head.toString("ascii");
  if (ascii.startsWith("%PDF")) return "pdf";
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image";
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) return "image";
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image";
  if (head.length >= 12 && ascii.slice(8, 12) === "WEBP") return "image";
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return "unknown";
  }
  return "unknown";
}
