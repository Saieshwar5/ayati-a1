import type {
  HandoffSummaryMemoryInput,
  RecallMemoryRecord,
  SummaryEmbeddingProvider,
  SummaryVectorStore,
  TaskSummaryMemoryInput,
} from "./types.js";

export interface MemoryIndexerOptions {
  embedder: SummaryEmbeddingProvider;
  store: SummaryVectorStore;
}

const MAX_SUMMARY_CHARS = 1_200;

export class MemoryIndexer {
  private readonly embedder: SummaryEmbeddingProvider;
  private readonly store: SummaryVectorStore;

  constructor(options: MemoryIndexerOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
  }

  async indexTaskSummary(input: TaskSummaryMemoryInput): Promise<void> {
    const summaryText = normalizeSummary(input.summary);
    if (!summaryText) {
      return;
    }

    const embedding = await this.embedder.embed(summaryText);
    const record: RecallMemoryRecord = {
      id: `task:${input.sessionId}:${input.runId}`,
      clientId: input.clientId,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      runId: input.runId,
      runPath: input.runPath,
      createdAt: input.timestamp,
      sourceType: "task_summary",
      summaryText,
      dayKey: toDayKey(input.timestamp),
      hourKey: toHourKey(input.timestamp),
      embedding,
    };

    await this.store.upsert(record);
  }

  async indexHandoffSummary(input: HandoffSummaryMemoryInput): Promise<void> {
    const summaryText = normalizeSummary(input.summary);
    if (!summaryText) {
      return;
    }

    const embedding = await this.embedder.embed(summaryText);
    const record: RecallMemoryRecord = {
      id: `handoff:${input.sessionId}:${input.timestamp}`,
      clientId: input.clientId,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      createdAt: input.timestamp,
      sourceType: "handoff",
      summaryText,
      dayKey: toDayKey(input.timestamp),
      hourKey: toHourKey(input.timestamp),
      embedding,
    };

    await this.store.upsert(record);
  }
}

function normalizeSummary(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length === 0) {
    return "";
  }
  return clean.slice(0, MAX_SUMMARY_CHARS);
}

function toDayKey(iso: string): string {
  return iso.slice(0, 10);
}

function toHourKey(iso: string): string {
  return iso.slice(0, 13);
}
