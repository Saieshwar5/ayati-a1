export const USER_FACTS_SECTION_ID = "user_facts" as const;
export const TIME_BASED_SECTION_ID = "time_based" as const;
export const EVOLVING_MEMORY_SECTION_ID = "evolving_memory" as const;

export type MemorySectionId =
  | typeof USER_FACTS_SECTION_ID
  | typeof TIME_BASED_SECTION_ID
  | typeof EVOLVING_MEMORY_SECTION_ID;
export type MemoryLifecycle = "fact" | "timed" | "evolving";

export type MemoryDecayCurve = "stable" | "linear" | "exponential" | "delayed_drop" | "super_fast";

export interface MemoryDecayConfig {
  curve: MemoryDecayCurve;
  graceDays: number;
  halfLifeDays: number;
  pressureSensitivity: number;
  contextThreshold: number;
  archiveThreshold: number;
}

export type MemoryState =
  | "candidate"
  | "active"
  | "archived"
  | "superseded"
  | "merged"
  | "expired"
  | "rejected";

export type MemorySourceType =
  | "explicit_user_statement"
  | "manual_user_request"
  | "agent_observation"
  | "inferred";

export type MemoryEvidenceType =
  | "creates"
  | "confirms"
  | "contradicts"
  | "supersedes"
  | "merges"
  | "archives"
  | "rejects";

export type MemoryUsageOutcome = "helpful" | "harmful" | "success" | "failure";

export interface MemoryPolicy {
  sections: {
    userFacts: {
      maxLiveCards: number;
      minActiveConfidence: number;
      admissionMargin: number;
      allowInferredFacts: boolean;
    };
    timeBased: {
      maxLiveCards: number;
      minActiveConfidence: number;
      admissionMargin: number;
    };
    evolvingMemory: {
      maxLiveCards: number;
      minActiveConfidence: number;
      admissionMargin: number;
      defaultContextThreshold: number;
      defaultArchiveThreshold: number;
      pressureStartsAtRatio: number;
      decay: {
        stable: MemoryDecayConfig;
        linear: MemoryDecayConfig;
        exponential: MemoryDecayConfig;
        delayedDrop: MemoryDecayConfig;
        superFast: MemoryDecayConfig;
      };
    };
  };
  extraction: {
    maxTurns: number;
    maxExistingFacts: number;
    maxExistingTimed: number;
    maxExistingEvolving: number;
    maxProposals: number;
  };
}

export interface MemoryCard {
  id: string;
  userId: string;
  sectionId: MemorySectionId;
  kind: string;
  slot: string;
  lifecycle: MemoryLifecycle;
  text: string;
  value?: string | null;
  startsAt?: string | null;
  eventAt?: string | null;
  expiresAt?: string | null;
  state: MemoryState;
  confidence: number;
  importance: number;
  confirmations: number;
  corrections: number;
  contradictions: number;
  helpfulHits: number;
  harmfulHits: number;
  sourceType: MemorySourceType;
  sourceReliability: number;
  createdAt: string;
  lastConfirmedAt: string;
  lastUsedAt?: string | null;
  supersededById?: string | null;
  mergedIntoId?: string | null;
  metadataJson?: string | null;
}

export type PersonalMemoryRecord = MemoryCard;

export interface MemoryEvidenceRecord {
  id: string;
  memoryId: string;
  userId: string;
  sessionId?: string | null;
  runId?: string | null;
  sessionPath?: string | null;
  runPath?: string | null;
  evidenceType: MemoryEvidenceType;
  sourceText: string;
  createdAt: string;
}

export interface MemoryConsolidationJobPayload {
  userId: string;
  sessionId: string;
  sessionPath: string;
  handoffSummary?: string | null;
  reason: string;
  turns: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
    sessionPath: string;
    runId?: string;
  }>;
}

export interface MemoryConsolidationJob {
  jobId: string;
  userId: string;
  sessionId: string;
  sessionPath: string;
  handoffSummary?: string | null;
  payloadJson: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  lastError?: string | null;
}

export interface MemoryProposal {
  text: string;
  sectionId?: MemorySectionId;
  lifecycle?: MemoryLifecycle;
  kind: string;
  slot: string;
  value?: string | null;
  startsAt?: string | null;
  eventAt?: string | null;
  expiresAt?: string | null;
  confidence: number;
  importance: number;
  sourceType: MemorySourceType;
  sourceReliability: number;
  evidence: string;
  reasoning?: string;
  decay?: Partial<MemoryDecayConfig> | null;
}

export interface MemoryResolveResult {
  created: number;
  confirmed: number;
  superseded: number;
  merged: number;
  archived: number;
  rejected: number;
  reasons: string[];
}

export interface MemoryScore {
  freshness: number;
  evidenceStrength: number;
  usefulness: number;
  urgency: number;
  pressureFactor: number;
  currentConfidence: number;
  retentionScore: number;
  contextThreshold: number;
  archiveThreshold: number;
}

export interface PromptPersonalMemory {
  id: string;
  sectionId: MemorySectionId;
  kind: string;
  slot: string;
  lifecycle: MemoryLifecycle;
  text: string;
  state: Extract<MemoryState, "active">;
  currentConfidence: number;
}
