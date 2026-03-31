import type { SourceChunk } from "../subagents/context-extractor/types.js";

export interface DocumentEmbeddingProvider {
  readonly modelName: string;
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
}

export interface DocumentChunkVectorRecord {
  id: string;
  documentId: string;
  checksum: string;
  sourceId: string;
  documentName: string;
  documentPath: string;
  location: string;
  text: string;
  tokens: number;
  embedding: number[];
  embeddingModel: string;
  indexedAt: string;
}

export interface DocumentChunkVectorMatch extends Omit<DocumentChunkVectorRecord, "checksum" | "embedding" | "embeddingModel" | "indexedAt"> {
  score: number;
}

export interface DocumentVectorSearchInput {
  documentIds: string[];
  vector: number[];
  embeddingModel: string;
  limit: number;
}

export interface DocumentVectorStore {
  upsertDocumentChunks(records: DocumentChunkVectorRecord[]): Promise<void>;
  search(input: DocumentVectorSearchInput): Promise<DocumentChunkVectorMatch[]>;
}

export interface DocumentVectorSearchResult {
  chunks: SourceChunk[];
  scores: number[];
}
