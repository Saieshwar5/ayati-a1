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
      type: "asset_registered";
      at: string;
      assetId: string;
    }
  | {
      seq: number;
      type: "task_branch_created";
      at: string;
      workId: string;
      branch: string;
      ref: string;
    }
  | {
      seq: number;
      type: "run_started";
      at: string;
      runId: string;
      workId: string;
    }
  | {
      seq: number;
      type: "run_committed";
      at: string;
      runId: string;
      workId: string;
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
      workId: string;
    }
  | {
      status: "missing";
      ref: string;
      workId?: string;
      reason: string;
    }
  | {
      status: "unresolved";
      ref: string;
      reason: string;
    };

export type TaskAssetRole = "input" | "output" | "generated" | "reference";

export interface TaskAssetRecord {
  assetId: string;
  role: TaskAssetRole;
  kind: string;
  name: string;
  description?: string;
  sessionAssetId?: string;
  path?: string;
}

export interface ContextTaskArtifactIdentity {
  name: string;
  type: string;
  description: string;
  aliases: string[];
}

export interface ContextTaskArtifactRecord {
  artifactId: string;
  source: "user_attachment" | "agent_workspace";
  kind: string;
  path: string;
  originalName?: string;
  mimeType?: string;
  role: string;
  identity: ContextTaskArtifactIdentity;
  status: string;
  reason?: string;
  createdByRunId?: string;
  lastTouchedRunId?: string;
  sourceRunId?: string;
  sourceTurnSeq?: number;
  confidence: string;
}

export interface ContextTaskFact {
  text: string;
  source: string;
}

export interface ContextTaskRunSummary {
  schemaVersion: 1;
  runId: string;
  workId: string;
  status: "completed" | "incomplete" | "failed" | "blocked" | "needs_user_input";
  stopReason?: string;
  summary: string;
  next?: string;
  firstBlocker?: string;
  blockerCount?: number;
  changedFileCount?: number;
  changedFilesPreview?: string[];
  toolCallCount?: number;
  completed: string[];
  open: string[];
  actions: string[];
  createdAt: string;
}

export interface ContextCommitSummary {
  commit: string;
  subject: string;
  summary?: string;
  conversationSummary?: string;
  workSummary?: string;
  assets?: Array<{
    path: string;
    description: string;
  }>;
  outcome?: string;
  validation?: string;
  event?: string;
  status?: string;
  at?: string;
  workId?: string;
  runId?: string;
  branch?: string;
}

export interface ContextTaskEvidenceSummary {
  runId: string;
  workId: string;
  step?: number;
  actionId?: string;
  tool: string;
  status?: string;
  summary: string;
  evidenceRef?: string;
  artifacts: string[];
  facts: string[];
  accessModes: string[];
  outputSize?: number;
  lineCount?: number;
  truncated?: boolean;
  source?: Record<string, unknown>;
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
  workId?: string;
  branch?: string;
  runId?: string;
}

export interface ContextSessionSummary {
  text: string;
  updatedAt?: string;
  coveredUntilSeq?: number;
}

export interface ContextSessionTaskRunCheckpoint {
  checkpointId: string;
  commit: string;
  workId: string;
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
  assetCount: number;
}

export interface ContextReadEntry {
  key: string;
  runId: string;
  step: number;
  runClass: "session" | "task";
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
  afterTaskRunId?: string;
  entries: ContextReadEntry[];
}

export interface ContextEngineMachineContext {
  session: {
    meta: ContextSessionMeta;
    conversationTail: ContextConversationRecord[];
    conversationMarkdownTail?: string;
    summary?: ContextSessionSummary;
    recentTaskRuns?: ContextSessionTaskRunCheckpoint[];
    attachments?: ContextSessionAttachments;
    activityTail: ContextSessionActivityRecord[];
    recentCommits?: ContextCommitSummary[];
    projection?: ContextSessionProjectionMetrics;
  };
  pendingWrites?: ContextPendingWrite[];
  pendingTurn?: ContextPendingTurn;
  focus: ContextFocus;
  readContext?: ContextReadContext;
  taskCandidates?: Array<{
    taskId: string;
    title: string;
    objective: string;
    workingDirectory: string;
    updatedAt: string;
  }>;
  task?: {
    /** Runtime-only active task checkout. Prompt projection intentionally omits it. */
    checkoutPath?: string;
    /** Stable user-facing directory where task files are edited. */
    workingDirectory?: string;
    ref: string;
    workId: string;
    title: string;
    objective: string;
    status: string;
    completed: string[];
    open: string[];
    blockers: string[];
    facts: ContextTaskFact[];
    next?: string;
    conversationMarkdownTail?: string;
    assets: TaskAssetRecord[];
    artifacts?: ContextTaskArtifactRecord[];
    recentRuns: ContextTaskRunSummary[];
    recentCommits: ContextCommitSummary[];
    recentEvidence: ContextTaskEvidenceSummary[];
  };
}

export type HarnessRunStatus = "completed" | "failed" | "stuck";
export type HarnessResponseKind = "reply" | "feedback" | "notification" | "none";
export type HarnessWorkStatus = "not_done" | "done" | "blocked" | "needs_user_input";

export interface HarnessWorkStateForContext {
  status: HarnessWorkStatus;
  summary: string;
  openWork?: string[];
  blockers?: string[];
  verifiedFacts: string[];
  evidence: string[];
  artifacts?: string[];
  nextStep?: string;
  userInputNeeded?: string;
}

export interface HarnessTaskSummaryForContext {
  stopReason?: string;
  summary?: string;
  completedMilestones?: string[];
  openWork?: string[];
  blockers?: string[];
  keyFacts?: string[];
  evidence?: string[];
  nextAction?: string;
}

export interface HarnessStepSummaryForContext {
  step: number;
  outcome: "success" | "failed" | string;
  summary: string;
  newFacts: string[];
  artifacts: string[];
  toolsUsed?: string[];
  executionContract?: string;
  evidenceSummary?: string;
  evidenceItems?: string[];
  evidenceSource?: Record<string, unknown>;
  outputSize?: number;
  lineCount?: number;
  truncated?: boolean;
  workState?: HarnessWorkStateForContext;
}

export interface HarnessRunResultForContext {
  type: HarnessResponseKind;
  status: HarnessRunStatus;
  content: string;
  totalIterations: number;
  totalToolCalls: number;
  runPath: string;
  workRunId?: string;
  taskSummary?: HarnessTaskSummaryForContext;
  workState?: HarnessWorkStateForContext;
  completedSteps?: HarnessStepSummaryForContext[];
  taskAssets?: TaskAssetRecord[];
  /** Exact assets accepted by deterministic task-completion verification. */
  verifiedCompletionAssets?: TaskAssetRecord[];
}
