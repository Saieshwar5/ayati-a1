export interface ChatAttachment {
  path: string;
  name?: string;
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

export interface ProcessedDocumentError {
  path: string;
  message: string;
}

export interface DocumentProcessingResult {
  documents: ProcessedDocument[];
  errors: ProcessedDocumentError[];
  totalSegments: number;
  totalChars: number;
}

export interface ExtractorInput {
  filePath: string;
  fileName: string;
  bytes: Buffer;
}

export interface ExtractorOutput {
  kind: DocumentKind;
  segments: DocumentSegment[];
  warnings?: string[];
}

export interface DocumentExtractor {
  supports(kind: DocumentKind): boolean;
  extract(input: ExtractorInput): Promise<ExtractorOutput>;
}
