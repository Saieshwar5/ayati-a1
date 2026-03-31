import type { SourceChunk } from "../subagents/context-extractor/types.js";
import type { PreparedManagedDocument } from "./document-store.js";
import type {
  DocumentEmbeddingProvider,
  DocumentVectorSearchResult,
  DocumentVectorStore,
} from "./document-vector-types.js";

export interface DocumentRetrieverOptions {
  embedder: DocumentEmbeddingProvider;
  store: DocumentVectorStore;
}

export class DocumentRetriever {
  private readonly embedder: DocumentEmbeddingProvider;
  private readonly store: DocumentVectorStore;

  constructor(options: DocumentRetrieverOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
  }

  async search(input: {
    query: string;
    documents: PreparedManagedDocument[];
    limit: number;
  }): Promise<DocumentVectorSearchResult> {
    if (input.documents.length === 0 || input.limit <= 0) {
      return { chunks: [], scores: [] };
    }

    const vector = await this.embedder.embed(input.query);
    const matches = await this.store.search({
      documentIds: input.documents.map((document) => document.manifest.documentId),
      vector,
      embeddingModel: this.embedder.modelName,
      limit: input.limit,
    });

    const chunks: SourceChunk[] = matches.map((match) => ({
      sourceId: match.sourceId,
      documentId: match.documentId,
      documentName: match.documentName,
      documentPath: match.documentPath,
      location: match.location,
      text: match.text,
      tokens: match.tokens,
    }));

    return {
      chunks,
      scores: matches.map((match) => match.score),
    };
  }
}
