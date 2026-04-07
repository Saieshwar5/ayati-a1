export type RecallSourceType = "run" | "handoff";

export type MemoryNodeType = RecallSourceType | "session";

export type MemoryEdgeType =
  | "session_contains_run"
  | "session_has_handoff"
  | "session_rotates_to_session"
  | "run_followed_by_run"
  | "run_precedes_handoff"
  | "handoff_opens_session";

export interface RecallMemoryRecord {
  id: string;
  clientId: string;
  nodeType: RecallSourceType;
  sourceType: RecallSourceType;
  sessionId: string;
  sessionPath: string;
  sessionFilePath: string;
  runId?: string;
  runPath?: string;
  runStatePath?: string;
  createdAt: string;
  status?: "completed" | "failed" | "stuck";
  summaryText: string;
  retrievalText: string;
  userMessage?: string;
  assistantResponse?: string;
  metadataJson?: string;
  embeddingModel: string;
  embedding: number[];
}

export interface RecallCandidate {
  nodeId: string;
  nodeType: RecallSourceType;
  sourceType: RecallSourceType;
  sessionId: string;
  sessionPath: string;
  sessionFilePath: string;
  runId?: string;
  runPath?: string;
  runStatePath?: string;
  createdAt: string;
  status?: "completed" | "failed" | "stuck";
  summaryText: string;
  retrievalText: string;
  userMessage?: string;
  assistantResponse?: string;
  metadataJson?: string;
  score: number;
}

export interface RecallRelatedNode {
  nodeId: string;
  nodeType: MemoryNodeType;
  relation: MemoryEdgeType;
  sourceType?: RecallSourceType;
  sessionId?: string;
  sessionPath?: string;
  sessionFilePath?: string;
  runId?: string;
  runPath?: string;
  runStatePath?: string;
  createdAt?: string;
  status?: "completed" | "failed" | "stuck";
  summaryText?: string;
}

export interface RecallMemoryMatch {
  nodeId: string;
  nodeType: RecallSourceType;
  sourceType: RecallSourceType;
  sessionId: string;
  sessionPath: string;
  sessionFilePath: string;
  runId?: string;
  runPath?: string;
  runStatePath?: string;
  createdAt: string;
  status?: "completed" | "failed" | "stuck";
  summaryText: string;
  userMessage?: string;
  assistantResponse?: string;
  score: number;
  related: RecallRelatedNode[];
}

export interface RecallQuery {
  clientId: string;
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  sourceTypes?: RecallSourceType[];
}

export interface RecallSearchInput {
  clientId: string;
  vector?: number[];
  dateFrom?: string;
  dateTo?: string;
  sourceTypes?: RecallSourceType[];
  limit: number;
}

export interface SummaryEmbeddingProvider {
  readonly modelName: string;
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
}

export interface SummaryVectorStore {
  upsert(record: RecallMemoryRecord): Promise<void>;
  search(input: RecallSearchInput): Promise<RecallCandidate[]>;
}

export interface TaskSummaryMemoryInput {
  clientId: string;
  sessionId: string;
  sessionPath: string;
  runId: string;
  runPath: string;
  status: "completed" | "failed" | "stuck";
  summary: string;
  userMessage?: string;
  assistantResponse?: string;
  timestamp: string;
}

export interface HandoffSummaryMemoryInput {
  clientId: string;
  sessionId: string;
  sessionPath: string;
  nextSessionId?: string;
  nextSessionPath?: string;
  reason?: string;
  summary: string;
  timestamp: string;
}

export interface MemoryJobRecord {
  jobId: string;
  jobType: "index_run" | "index_handoff";
  clientId: string;
  payloadJson: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
}

export interface MemoryNodeRecord {
  nodeId: string;
  clientId: string;
  nodeType: MemoryNodeType;
  sourceType?: RecallSourceType;
  sessionId?: string;
  sessionPath?: string;
  sessionFilePath?: string;
  runId?: string;
  runPath?: string;
  runStatePath?: string;
  createdAt: string;
  status?: "completed" | "failed" | "stuck";
  summaryText: string;
  retrievalText?: string;
  userMessage?: string;
  assistantResponse?: string;
  metadataJson?: string;
}

export interface MemoryEdgeRecord {
  edgeId: string;
  clientId: string;
  fromNodeId: string;
  edgeType: MemoryEdgeType;
  toNodeId: string;
  createdAt: string;
}

export interface MemoryGraphExpansion {
  [nodeId: string]: RecallRelatedNode[];
}
