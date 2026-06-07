export interface EmbeddingProvider {
  readonly name: string;
  readonly modelName: string;
  readonly dimensions?: number;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
