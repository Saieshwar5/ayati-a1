export interface ChatAttachment {
  path: string;
  name?: string;
}

export interface ManagedDocumentManifest {
  documentId: string;
  name: string;
  originalPath: string;
  storedPath: string;
  kind: DocumentKind;
  sizeBytes: number;
  checksum: string;
}

export type DocumentKind =
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx"
  | "csv"
  | "txt"
  | "markdown"
  | "json"
  | "html"
  | "unknown";

export interface DocumentSegment {
  id: string;
  location: string;
  text: string;
}

export interface ProcessedDocument {
  id: string;
  name: string;
  path: string;
  kind: DocumentKind;
  sizeBytes: number;
  segments: DocumentSegment[];
  warnings: string[];
}
