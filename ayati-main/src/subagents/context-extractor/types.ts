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
