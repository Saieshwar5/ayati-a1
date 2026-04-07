import OpenAI from "openai";
import type { SummaryEmbeddingProvider } from "./types.js";

export interface OpenAiMemoryEmbedderOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
  batchSize?: number;
}

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_BATCH_SIZE = 32;

export class OpenAiMemoryEmbedder implements SummaryEmbeddingProvider {
  readonly modelName: string;

  private readonly client: OpenAI;
  private readonly dimensions?: number;
  private readonly batchSize: number;

  constructor(options?: OpenAiMemoryEmbedderOptions) {
    const apiKey = options?.apiKey?.trim() || process.env["OPENAI_API_KEY"]?.trim();
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY environment variable for memory embeddings.");
    }

    this.modelName = options?.model?.trim()
      || process.env["OPENAI_MEMORY_EMBEDDING_MODEL"]?.trim()
      || DEFAULT_EMBEDDING_MODEL;
    this.dimensions = options?.dimensions ?? parseOptionalPositiveInt(process.env["OPENAI_MEMORY_EMBEDDING_DIMENSIONS"]);
    this.batchSize = Math.max(1, options?.batchSize ?? DEFAULT_BATCH_SIZE);
    this.client = new OpenAI({
      apiKey,
      ...(options?.baseURL?.trim() ? { baseURL: options.baseURL.trim() } : {}),
    });
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const results: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const slice = texts.slice(offset, offset + this.batchSize).map(normalizeEmbeddingInput);
      const response = await this.client.embeddings.create({
        model: this.modelName,
        input: slice,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      });
      results.push(...response.data.map((entry) => entry.embedding.map((value) => Number(value) || 0)));
    }

    return results;
  }
}

function normalizeEmbeddingInput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : " ";
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
