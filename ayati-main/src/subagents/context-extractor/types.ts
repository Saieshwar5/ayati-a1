import type { ProcessedDocument } from "../../documents/types.js";

export interface SourceChunk {
  sourceId: string;
  documentId: string;
  documentName: string;
  documentPath: string;
  location: string;
  text: string;
  tokens: number;
}

export interface ContextEvidenceItem {
  fact: string;
  quote: string;
  sourceId: string;
  citation: {
    documentName: string;
    documentPath: string;
    location: string;
  };
  relevance: number;
  confidence: number;
}

export interface ContextBundle {
  query: string;
  items: ContextEvidenceItem[];
  confidence: number;
  insufficientEvidence: boolean;
  droppedNoiseCount: number;
  trace: {
    depthReached: number;
    recursionCalls: number;
    llmCalls: number;
    totalInputTokens: number;
  };
}

export interface ContextExtractorInput {
  query: string;
  documents: ProcessedDocument[];
}

export interface ContextExtractorResult {
  contextBundle: ContextBundle;
  warnings: string[];
}
