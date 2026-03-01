export type RecallSourceType = "task_summary" | "handoff";

export interface RecallMemoryRecord {
  id: string;
  clientId: string;
  sessionId: string;
  sessionPath: string;
  runId?: string;
  runPath?: string;
  createdAt: string;
  sourceType: RecallSourceType;
  summaryText: string;
  dayKey: string;
  hourKey: string;
  embedding: number[];
}

export interface RecallMemoryMatch {
  sessionId: string;
  sessionPath: string;
  createdAt: string;
  sourceType: RecallSourceType;
  summaryText: string;
  score: number;
}

export interface RecallQuery {
  clientId: string;
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface RecallSearchInput {
  clientId: string;
  vector?: number[];
  dateFrom?: string;
  dateTo?: string;
  limit: number;
}

export interface SummaryEmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface SummaryVectorStore {
  upsert(record: RecallMemoryRecord): Promise<void>;
  search(input: RecallSearchInput): Promise<RecallMemoryMatch[]>;
}

export interface TaskSummaryMemoryInput {
  clientId: string;
  sessionId: string;
  sessionPath: string;
  runId: string;
  runPath: string;
  status: "completed" | "failed" | "stuck";
  summary: string;
  timestamp: string;
}

export interface HandoffSummaryMemoryInput {
  clientId: string;
  sessionId: string;
  sessionPath: string;
  summary: string;
  timestamp: string;
}
