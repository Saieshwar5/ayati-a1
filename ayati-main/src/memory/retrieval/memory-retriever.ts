import { MemoryGraphStore } from "./memory-graph-store.js";
import type {
  RecallCandidate,
  RecallMemoryMatch,
  RecallQuery,
  SummaryEmbeddingProvider,
  SummaryVectorStore,
} from "./types.js";

export interface MemoryRetrieverOptions {
  embedder: SummaryEmbeddingProvider;
  store: SummaryVectorStore;
  graphStore: MemoryGraphStore;
}

export class MemoryRetriever {
  private readonly embedder: SummaryEmbeddingProvider;
  private readonly store: SummaryVectorStore;
  private readonly graphStore: MemoryGraphStore;

  constructor(options: MemoryRetrieverOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
    this.graphStore = options.graphStore;
  }

  async recall(input: RecallQuery): Promise<RecallMemoryMatch[]> {
    const limit = clampLimit(input.limit);
    const query = input.query?.trim() ?? "";
    const vector = query.length > 0
      ? await this.embedder.embed(query)
      : undefined;

    const candidateLimit = Math.min(Math.max(limit * 3, limit), 24);
    const candidates = await this.store.search({
      clientId: input.clientId,
      vector,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      sourceTypes: input.sourceTypes,
      limit: candidateLimit,
    });
    if (candidates.length === 0) {
      return [];
    }

    const reranked = rerankCandidates(candidates, query).slice(0, limit);
    const expansion = this.graphStore.expand(reranked.map((candidate) => candidate.nodeId), input.clientId, 4);

    return reranked.map((candidate) => ({
      nodeId: candidate.nodeId,
      nodeType: candidate.nodeType,
      sourceType: candidate.sourceType,
      sessionId: candidate.sessionId,
      sessionPath: candidate.sessionPath,
      sessionFilePath: candidate.sessionFilePath,
      runId: candidate.runId,
      runPath: candidate.runPath,
      runStatePath: candidate.runStatePath,
      createdAt: candidate.createdAt,
      status: candidate.status,
      summaryText: candidate.summaryText,
      userMessage: candidate.userMessage,
      assistantResponse: candidate.assistantResponse,
      score: candidate.score,
      related: expansion[candidate.nodeId] ?? [],
    }));
  }
}

function clampLimit(value?: number): number {
  if (!Number.isFinite(value) || typeof value !== "number") {
    return 5;
  }
  return Math.max(1, Math.min(8, Math.floor(value)));
}

function rerankCandidates(candidates: RecallCandidate[], query: string): RecallCandidate[] {
  const now = Date.now();
  const queryTokens = tokenize(query);
  return [...candidates]
    .map((candidate) => ({
      candidate,
      finalScore: computeHybridScore(candidate, queryTokens, now),
    }))
    .sort((a, b) => {
      if (b.finalScore !== a.finalScore) {
        return b.finalScore - a.finalScore;
      }
      return b.candidate.createdAt.localeCompare(a.candidate.createdAt);
    })
    .map(({ candidate, finalScore }) => ({
      ...candidate,
      score: Number(finalScore.toFixed(4)),
    }));
}

function computeHybridScore(candidate: RecallCandidate, queryTokens: Set<string>, now: number): number {
  const baseScore = candidate.score;
  if (queryTokens.size === 0) {
    return baseScore + recencyBoost(candidate.createdAt, now);
  }

  const lexicalSource = [
    candidate.summaryText,
    candidate.userMessage,
    candidate.assistantResponse,
    candidate.retrievalText,
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
  const lexicalScore = tokenOverlap(queryTokens, tokenize(lexicalSource));
  return (baseScore * 0.72) + (lexicalScore * 0.23) + recencyBoost(candidate.createdAt, now);
}

function recencyBoost(createdAt: string, now: number): number {
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) {
    return 0;
  }
  const ageDays = Math.max(0, (now - ts) / 86_400_000);
  return Math.max(0, 0.05 - Math.min(ageDays, 30) * 0.0015);
}

function tokenize(value: string): Set<string> {
  const matches = value.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? [];
  return new Set(matches.filter((token) => !STOPWORDS.has(token)));
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of left) {
    if (right.has(token)) {
      matches++;
    }
  }
  return matches / left.size;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "did",
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
  "the",
  "to",
  "we",
  "what",
  "when",
  "where",
  "with",
]);
