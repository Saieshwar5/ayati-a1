export type FileOrigin =
  | "user_upload"
  | "telegram_upload"
  | "local_path"
  | "agent_download"
  | "generated_artifact";

export type FileKind =
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

export type FileCapability =
  | "text"
  | "table"
  | "image"
  | "ocr_candidate"
  | "unsupported";

export type FileProcessingStatus = "new" | "ready" | "partial" | "failed" | "unsupported";

export interface ManagedFileRecord {
  fileId: string;
  sha256: string;
  originalName: string;
  safeName: string;
  kind: FileKind;
  mimeType?: string;
  sizeBytes: number;
  origin: FileOrigin;
  storagePath: string;
  metadataPath: string;
  derivedDir: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  capabilities: FileCapability[];
  processingStatus: FileProcessingStatus;
  warnings: string[];
  sourceUri?: string;
  originalPath?: string;
}

export interface RunFileReference {
  fileId: string;
  role: "attached" | "found" | "downloaded" | "generated" | "used";
  addedAt: string;
}

export interface RunFilesManifest {
  runId: string;
  files: RunFileReference[];
}

export interface PreparedTextSection {
  id: string;
  location: string;
  text: string;
}

export interface PreparedTextChunk {
  id: string;
  location: string;
  text: string;
  tokens: number;
}

export interface PreparedTextData {
  extractor: "direct" | "pandoc" | "tika";
  sectionCount: number;
  chunkCount: number;
  sections: PreparedTextSection[];
  chunks: PreparedTextChunk[];
  warnings: string[];
}

export type StructuredCellValue = string | number | boolean | null;

export interface PreparedTableData {
  tableName: string;
  dbPath: string;
  columns: string[];
  inferredTypes: Record<string, string>;
  rowCount: number;
  sampleRows: Array<Record<string, StructuredCellValue>>;
  sheetName?: string;
  sheetNames?: string[];
  warnings: string[];
}

export interface PreparedImageData {
  width?: number;
  height?: number;
  mimeType?: string;
  sizeBytes: number;
  warnings: string[];
}

export interface PreparedFileRecord {
  file: ManagedFileRecord;
  text?: PreparedTextData;
  table?: PreparedTableData;
  image?: PreparedImageData;
}

export interface RegisterFileInput {
  originalName: string;
  bytes: Uint8Array;
  origin: FileOrigin;
  mimeType?: string;
  runId?: string;
  runRole?: RunFileReference["role"];
  sourceUri?: string;
  originalPath?: string;
}

export interface RegisterPathInput {
  path: string;
  name?: string;
  origin?: Extract<FileOrigin, "local_path" | "generated_artifact">;
  runId?: string;
  runRole?: RunFileReference["role"];
}

export interface FetchUrlInput {
  url: string;
  originalName?: string;
  mimeType?: string;
  runId?: string;
  maxBytes?: number;
}

export interface PrepareFileOptions {
  sheetName?: string;
  maxChunkTokens?: number;
}
