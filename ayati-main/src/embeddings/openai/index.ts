import OpenAI from "openai";
import {
  getEmbeddingDimensionsForProvider,
  getEmbeddingModelForProvider,
} from "../../config/llm-runtime-config.js";
import type { EmbeddingProvider } from "../contracts.js";

const DEFAULT_BATCH_SIZE = 32;

let client: OpenAI | null = null;

const provider: EmbeddingProvider = {
  name: "openai",

  get modelName() {
    return getEmbeddingModelForProvider("openai");
  },

  get dimensions() {
    return getEmbeddingDimensionsForProvider("openai");
  },

  start() {
    const apiKey = process.env["OPENAI_API_KEY"]?.trim();
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY environment variable for embeddings.");
    }

    client = new OpenAI({ apiKey });
  },

  stop() {
    client = null;
  },

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  },

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!client) {
      throw new Error("OpenAI embedding provider not started.");
    }
    if (texts.length === 0) {
      return [];
    }

    const results: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += DEFAULT_BATCH_SIZE) {
      const slice = texts.slice(offset, offset + DEFAULT_BATCH_SIZE).map(normalizeEmbeddingInput);
      const response = await client.embeddings.create({
        model: this.modelName,
        input: slice,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      });
      results.push(...response.data.map((entry) => entry.embedding.map((value) => Number(value) || 0)));
    }

    return results;
  },
};

export default provider;

function normalizeEmbeddingInput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : " ";
}
