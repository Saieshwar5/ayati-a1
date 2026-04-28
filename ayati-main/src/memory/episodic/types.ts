export type EpisodicMemoryEpisodeType =
  | "conversation_exchange"
  | "task_outcome"
  | "session_summary";

export interface EpisodicMemorySettings {
  clientId: string;
  episodicEnabled: boolean;
  embeddingProvider: "openai";
  embeddingModel: string;
  updatedAt: string;
}

export interface EpisodicMemoryEpisode {
  episodeId: string;
  clientId: string;
  sessionId: string;
  sessionPath: string;
  sessionFilePath: string;
  runId?: string;
  episodeType: EpisodicMemoryEpisodeType;
  createdAt: string;
  eventStartIndex: number;
  eventEndIndex: number;
  summary: string;
  sourceText: string;
  embeddingText: string;
  contentHash: string;
}

export interface EpisodicMemoryRecord extends EpisodicMemoryEpisode {
  embeddingModel: string;
  vector: number[];
  indexedAt: string;
}

export interface EpisodicRecallQuery {
  clientId: string;
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  episodeTypes?: EpisodicMemoryEpisodeType[];
}

export interface EpisodicVectorSearchInput {
  clientId: string;
  embeddingModel: string;
  vector?: number[];
  dateFrom?: string;
  dateTo?: string;
  episodeTypes?: EpisodicMemoryEpisodeType[];
  limit: number;
}

export interface EpisodicRecallMatch {
  episodeId: string;
  episodeType: EpisodicMemoryEpisodeType;
  createdAt: string;
  summary: string;
  matchedText: string;
  score: number;
  sessionId: string;
  sessionPath: string;
  sessionFilePath: string;
  runId?: string;
  eventStartIndex: number;
  eventEndIndex: number;
  contentHash: string;
}

export interface EpisodicVectorStore {
  upsertEpisodes(records: EpisodicMemoryRecord[]): Promise<void>;
  search(input: EpisodicVectorSearchInput): Promise<EpisodicRecallMatch[]>;
}

export interface EpisodicSessionIndexPayload {
  clientId: string;
  sessionId: string;
  sessionPath: string;
  sessionFilePath: string;
  reason: string;
  handoffSummary?: string | null;
}

export interface EpisodicMemoryJob {
  jobId: string;
  jobType: "index_session";
  clientId: string;
  sessionId: string;
  sessionPath: string;
  sessionFilePath: string;
  reason: string;
  handoffSummary?: string | null;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
}

export interface EpisodicMemoryStatus {
  clientId: string;
  episodicEnabled: boolean;
  embeddingProvider: "openai";
  embeddingModel: string;
  embeddingAvailable: boolean;
  pendingJobs: number;
  runningJobs: number;
  failedJobs: number;
  doneJobs: number;
}
