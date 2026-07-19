import type {
  ResourceRef,
  WorkstreamCandidate,
  WorkstreamResourceBinding,
} from "ayati-git-context";

export type ContextConversationRole = "user" | "assistant" | "system";

export interface ContextConversationRecord {
  seq: number;
  messageId?: string;
  conversationId?: string;
  conversationSequence?: number;
  segmentSequence?: number;
  role: ContextConversationRole;
  kind?: "message" | "feedback_question";
  at: string;
  text: string;
}

export type ContextSessionActivityRecord =
  | {
      seq: number;
      type: "session_started";
      at: string;
      sessionId: string;
    }
  | {
      seq: number;
      type: "resource_registered";
      at: string;
      resourceId: string;
    }
  | {
      seq: number;
      type: "run_started";
      at: string;
      runId: string;
      workstreamId?: string;
    }
  | {
      seq: number;
      type: "workstream_context_committed";
      at: string;
      runId: string;
      workstreamId: string;
      commit: string;
    }
  | {
      seq: number;
      type: "session_closed";
      at: string;
      reason?: string;
    };

export type ContextFocus =
  | {
      status: "none";
    }
  | {
      status: "active";
      ref: string;
      workstreamId: string;
    }
  | {
      status: "missing";
      ref: string;
      workstreamId?: string;
      reason: string;
    }
  | {
      status: "unresolved";
      ref: string;
      reason: string;
    };

export type ContextResourceRecord = WorkstreamResourceBinding;

export interface ContextCommitSummary {
  commit: string;
  subject: string;
  summary?: string;
  conversationSummary?: string;
  workSummary?: string;
  resources?: Array<{
    path: string;
    description: string;
  }>;
  outcome?: string;
  validation?: string;
  event?: string;
  status?: string;
  at?: string;
  workstreamId?: string;
  runId?: string;
  branch?: string;
}

export interface ContextPendingWrite {
  id: string;
  type: string;
  label: string;
  status: "pending" | "writing" | "failed";
  createdAt: string;
  startedAt?: string;
  failedAt?: string;
  error?: string;
}

export interface ContextPendingTurn {
  fromSeq: number;
  toSeq: number;
  text: string;
  at: string;
  routingStatus: "unbound" | "bound" | "clarifying";
  workstreamId?: string;
  branch?: string;
  runId?: string;
}

export interface ContextSessionSummary {
  text: string;
  updatedAt?: string;
  coveredUntilSeq?: number;
}

export interface ContextSessionRunCheckpoint {
  checkpointId: string;
  commit: string;
  workstreamId: string;
  runId: string;
  status: "completed" | "incomplete" | "failed" | "blocked" | "needs_user_input";
  fromSeq: number;
  toSeq: number;
  sourceHash: string;
  strategy: "llm" | "deterministic";
  at: string;
  summary: string;
}

export interface ContextSessionProjectionMetrics {
  latestConversationSeq: number;
  checkpointBoundarySeq?: number;
  summaryTokens: number;
  checkpointTokens: number;
  timelineTokens: number;
  attachmentTokens: number;
  totalSessionTokens: number;
}

export interface ContextSessionAttachmentRecord {
  sessionAssetId: string;
  kind: string;
  name: string;
  source: string;
  status: string;
  documentId?: string;
  fileId?: string;
  directoryId?: string;
  originalPath?: string;
  storedPath?: string;
  sizeBytes?: number;
  mimeType?: string;
  checksum?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ContextSessionAttachments {
  count: number;
  recent: ContextSessionAttachmentRecord[];
  updatedAt?: string;
}

export interface ContextSessionMeta {
  sessionId: string;
  date?: string;
  timezone?: string;
  createdAt?: string;
  repoKind?: "daily_session";
  agentId?: string;
  resourceCount: number;
}

export interface ContextReadEntry {
  key: string;
  runId: string;
  step: number;
  callId?: string;
  tool: string;
  purpose: string;
  resources: string[];
  input?: unknown;
  output?: unknown;
  outputHash?: string;
  verification: unknown;
  createdAt: string;
}

export interface ContextReadContext {
  revision: string;
  afterCommitRunId?: string;
  inventory: ContextReadEntry[];
  discovery: ContextReadEntry[];
  evidence: ContextReadEntry[];
  actions: ContextReadEntry[];
}

export interface ContextEngineMachineContext {
  session: {
    meta: ContextSessionMeta;
    conversationTail: ContextConversationRecord[];
    conversationMarkdownTail?: string;
    summary?: ContextSessionSummary;
    recentRunCheckpoints?: ContextSessionRunCheckpoint[];
    attachments?: ContextSessionAttachments;
    activityTail: ContextSessionActivityRecord[];
    recentCommits?: ContextCommitSummary[];
    projection?: ContextSessionProjectionMetrics;
  };
  pendingWrites?: ContextPendingWrite[];
  pendingTurn?: ContextPendingTurn;
  focus: ContextFocus;
  readContext?: ContextReadContext;
  workstreamCandidates?: WorkstreamCandidate[];
  ingressResources?: ResourceRef[];
  workstream?: {
    contextRepositoryPath: string;
    ref: string;
    workstreamId: string;
    title: string;
    objective: string;
    summary: string;
    workstreamStatus: "in_progress" | "done" | "blocked";
    lifecycleStatus: "active" | "paused" | "archived";
    repositoryHealth: "ready" | "dirty_external";
    currentFocus?: string;
    blockers: string[];
    next?: string;
    currentRequest?: {
      id: string;
      title: string;
      status: "queued" | "active" | "blocked" | "done" | "dropped";
      request: string;
      acceptance: string[];
      constraints: string[];
    };
    resources: ContextResourceRecord[];
    recentCommits: ContextCommitSummary[];
  };
}
