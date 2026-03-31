import type { DocumentKind, PreparedAttachmentMode } from "./types.js";

const STRUCTURED_DATA_KINDS = new Set<DocumentKind>(["csv", "xlsx"]);
const UNSTRUCTURED_TEXT_KINDS = new Set<DocumentKind>(["pdf", "docx", "txt", "markdown", "html"]);

export function resolvePreparedAttachmentMode(kind: DocumentKind): PreparedAttachmentMode {
  if (STRUCTURED_DATA_KINDS.has(kind)) {
    return "structured_data";
  }
  if (UNSTRUCTURED_TEXT_KINDS.has(kind)) {
    return "unstructured_text";
  }
  return "unsupported";
}

export function isStructuredDataKind(kind: DocumentKind): boolean {
  return resolvePreparedAttachmentMode(kind) === "structured_data";
}

export function isUnstructuredTextKind(kind: DocumentKind): boolean {
  return resolvePreparedAttachmentMode(kind) === "unstructured_text";
}
