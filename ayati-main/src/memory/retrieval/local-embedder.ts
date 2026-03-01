import { resolve } from "node:path";
import type { SummaryEmbeddingProvider } from "./types.js";

export interface LocalTextEmbedderOptions {
  cacheDir?: string;
  dimensions?: number;
  preferTransformers?: boolean;
}

const DEFAULT_DIMENSIONS = 384;
const WORD_PATTERN = /[a-z0-9]+/g;

export class LocalTextEmbedder implements SummaryEmbeddingProvider {
  private readonly cacheDir: string;
  private readonly dimensions: number;
  private readonly preferTransformers: boolean;
  private extractorPromise: Promise<unknown> | null = null;
  private transformersEnabled = true;

  constructor(options?: LocalTextEmbedderOptions) {
    this.cacheDir = options?.cacheDir ?? resolve(process.cwd(), "data", "models-cache");
    this.dimensions = Math.max(32, options?.dimensions ?? DEFAULT_DIMENSIONS);
    this.preferTransformers = options?.preferTransformers !== false;
  }

  async embed(text: string): Promise<number[]> {
    const clean = text.trim();
    if (clean.length === 0) {
      return new Array(this.dimensions).fill(0);
    }

    if (this.preferTransformers) {
      const embedded = await this.tryTransformersEmbedding(clean);
      if (embedded) {
        return embedded;
      }
    }

    return this.embedHashedText(clean);
  }

  private async tryTransformersEmbedding(text: string): Promise<number[] | null> {
    if (!this.transformersEnabled) {
      return null;
    }

    try {
      const extractor = await this.getExtractor();
      if (!extractor) {
        return null;
      }

      const result = await extractor(text, {
        pooling: "mean",
        normalize: true,
      });

      const tensorLike = result as { tolist?: () => unknown };
      const list = typeof tensorLike.tolist === "function"
        ? tensorLike.tolist()
        : result;

      if (Array.isArray(list) && Array.isArray(list[0])) {
        const row = list[0];
        if (Array.isArray(row)) {
          return row.map((value) => Number(value) || 0);
        }
      }

      if (Array.isArray(list)) {
        return list.map((value) => Number(value) || 0);
      }
    } catch {
      this.transformersEnabled = false;
      this.extractorPromise = null;
    }

    return null;
  }

  private async getExtractor(): Promise<((text: string, options?: Record<string, unknown>) => Promise<unknown>) | null> {
    if (!this.transformersEnabled) {
      return null;
    }

    if (!this.extractorPromise) {
      this.extractorPromise = this.loadExtractor();
    }

    try {
      const loaded = await this.extractorPromise;
      if (typeof loaded === "function") {
        return loaded as (text: string, options?: Record<string, unknown>) => Promise<unknown>;
      }
    } catch {
      this.transformersEnabled = false;
      this.extractorPromise = null;
    }

    return null;
  }

  private async loadExtractor(): Promise<unknown> {
    const module = await importExternalModule("@huggingface/transformers");
    if (!module) {
      this.transformersEnabled = false;
      return null;
    }

    const env = (module as { env?: Record<string, unknown> }).env;
    if (env && typeof env === "object") {
      env["cacheDir"] = this.cacheDir;
    }

    const pipeline = (module as { pipeline?: unknown }).pipeline;
    if (typeof pipeline !== "function") {
      this.transformersEnabled = false;
      return null;
    }

    return (pipeline as (...args: unknown[]) => Promise<unknown>)(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { dtype: "q8" },
    );
  }

  private embedHashedText(text: string): number[] {
    const vector = new Array(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(WORD_PATTERN) ?? [];

    if (tokens.length === 0) {
      return vector;
    }

    for (const token of tokens) {
      const idx = stableHash(token) % this.dimensions;
      vector[idx] += 1;
    }

    const norm = Math.hypot(...vector);
    if (norm === 0) {
      return vector;
    }

    return vector.map((value) => value / norm);
  }
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

async function importExternalModule(specifier: string): Promise<unknown | null> {
  try {
    const importer = new Function("s", "return import(s);") as (name: string) => Promise<unknown>;
    return await importer(specifier);
  } catch {
    return null;
  }
}
