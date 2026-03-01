import type {
  RecallMemoryMatch,
  RecallQuery,
  SummaryEmbeddingProvider,
  SummaryVectorStore,
} from "./types.js";

export interface MemoryRetrieverOptions {
  embedder: SummaryEmbeddingProvider;
  store: SummaryVectorStore;
}

export class MemoryRetriever {
  private readonly embedder: SummaryEmbeddingProvider;
  private readonly store: SummaryVectorStore;

  constructor(options: MemoryRetrieverOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
  }

  async recall(input: RecallQuery): Promise<RecallMemoryMatch[]> {
    const limit = clampLimit(input.limit);
    const query = input.query?.trim() ?? "";
    const vector = query.length > 0
      ? await this.embedder.embed(query)
      : undefined;

    return this.store.search({
      clientId: input.clientId,
      vector,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      limit,
    });
  }
}

function clampLimit(value?: number): number {
  if (!Number.isFinite(value) || typeof value !== "number") {
    return 5;
  }
  return Math.max(1, Math.min(8, Math.floor(value)));
}
