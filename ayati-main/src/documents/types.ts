export type DocumentAttachmentSource = "cli" | "web";

export interface CliChatAttachment {
  source?: "cli";
  path: string;
  name?: string;
}

export interface WebChatAttachment {
  source: "web";
  uploadedPath: string;
  originalName: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type ChatAttachment = CliChatAttachment | WebChatAttachment;

export interface ManagedDocumentManifest {
  documentId: string;
  name: string;
  displayName: string;
  source: DocumentAttachmentSource;
  originalPath: string;
  storedPath: string;
  kind: DocumentKind;
  mimeType?: string;
  sizeBytes: number;
  checksum: string;
}

export type DocumentKind =
  | "image"
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

export type PreparedAttachmentMode = "structured_data" | "unstructured_text" | "unsupported";

export type PreparedAttachmentStatus = "ready" | "partial" | "failed" | "unsupported";

export interface PreparedStructuredAttachmentSummary {
  columns: string[];
  inferredTypes: Record<string, string>;
  rowCount: number;
  sampleRowCount: number;
  sheetName?: string;
  sheetCount?: number;
  stagingDbPath: string;
  stagingTableName: string;
  staged: boolean;
}

export interface PreparedUnstructuredAttachmentSummary {
  extractorUsed: string;
  sectionCount: number;
  chunkCount: number;
  sectionHints: string[];
  indexed: boolean;
}

export interface PreparedAttachmentSummary {
  preparedInputId: string;
  documentId: string;
  displayName: string;
  source: DocumentAttachmentSource;
  kind: DocumentKind;
  mode: PreparedAttachmentMode;
  sizeBytes: number;
  checksum: string;
  originalPath: string;
  status: PreparedAttachmentStatus;
  warnings: string[];
  artifactPath: string;
  structured?: PreparedStructuredAttachmentSummary;
  unstructured?: PreparedUnstructuredAttachmentSummary;
}

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
