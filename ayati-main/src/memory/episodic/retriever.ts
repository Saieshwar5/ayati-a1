import type { SummaryEmbeddingProvider } from "../embedding-provider.js";
import { EpisodicMemorySettingsStore } from "./settings-store.js";
import type {
  EpisodicRecallMatch,
  EpisodicRecallQuery,
  EpisodicVectorStore,
} from "./types.js";

export interface EpisodicMemoryRetrieverOptions {
  settingsStore: EpisodicMemorySettingsStore;
  vectorStore: EpisodicVectorStore;
  embedder?: SummaryEmbeddingProvider;
}

export class EpisodicMemoryRetriever {
  private readonly settingsStore: EpisodicMemorySettingsStore;
  private readonly vectorStore: EpisodicVectorStore;
  private readonly embedder?: SummaryEmbeddingProvider;

  constructor(options: EpisodicMemoryRetrieverOptions) {
    this.settingsStore = options.settingsStore;
    this.vectorStore = options.vectorStore;
    this.embedder = options.embedder;
  }

  async recall(input: EpisodicRecallQuery): Promise<EpisodicRecallMatch[]> {
    const settings = this.settingsStore.get(input.clientId);
    if (!settings.episodicEnabled || !this.embedder) {
      return [];
    }

    const limit = clampLimit(input.limit);
    const query = input.query?.trim() ?? "";
    const vector = query.length > 0
      ? normalizeVector(await this.embedder.embed(query))
      : undefined;
    const candidates = await this.vectorStore.search({
      clientId: input.clientId,
      embeddingModel: this.embedder.modelName,
      vector,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      episodeTypes: input.episodeTypes,
      limit: Math.min(Math.max(limit * 3, limit), 24),
    });

    return rerank(candidates, query).slice(0, limit);
  }
}

function clampLimit(value?: number): number {
  if (!Number.isFinite(value) || typeof value !== "number") {
    return 5;
  }
  return Math.max(1, Math.min(8, Math.floor(value)));
}

function rerank(candidates: EpisodicRecallMatch[], query: string): EpisodicRecallMatch[] {
  const tokens = tokenize(query);
  const now = Date.now();
  return [...candidates]
    .map((match) => ({
      match,
      score: computeScore(match, tokens, now),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.match.createdAt.localeCompare(a.match.createdAt);
    })
    .map(({ match, score }) => ({
      ...match,
      score: Number(score.toFixed(4)),
    }));
}

function computeScore(match: EpisodicRecallMatch, queryTokens: Set<string>, now: number): number {
  const lexicalScore = queryTokens.size === 0
    ? 0
    : tokenOverlap(queryTokens, tokenize(`${match.summary}\n${match.matchedText}`));
  return (match.score * 0.82) + (lexicalScore * 0.13) + recencyBoost(match.createdAt, now) + episodeTypeBoost(match.episodeType);
}

function episodeTypeBoost(episodeType: EpisodicRecallMatch["episodeType"]): number {
  if (episodeType === "conversation_exchange") {
    return 0.015;
  }
  if (episodeType === "task_outcome") {
    return 0.01;
  }
  return 0.005;
}

function recencyBoost(createdAt: string, now: number): number {
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) {
    return 0;
  }
  const ageDays = Math.max(0, (now - ts) / 86_400_000);
  return Math.max(0, 0.04 - Math.min(ageDays, 30) * 0.0012);
}

function tokenize(value: string): Set<string> {
  const matches = value.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? [];
  return new Set(matches.filter((token) => !STOPWORDS.has(token)));
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) {
      hits++;
    }
  }
  return hits / left.size;
}

function normalizeVector(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  if (sum === 0) {
    return vector;
  }
  const norm = Math.sqrt(sum);
  return vector.map((value) => value / norm);
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "with",
  "you",
]);
