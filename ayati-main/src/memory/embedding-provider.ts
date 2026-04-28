export interface SummaryEmbeddingProvider {
  readonly modelName: string;
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
}
