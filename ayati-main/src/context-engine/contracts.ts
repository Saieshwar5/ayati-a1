export type ContextConversationRole = "user" | "assistant" | "system";

export interface ContextConversationRecord {
  seq: number;
  role: ContextConversationRole;
  at: string;
  text: string;
}

export type ContextSessionEventRecord =
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
  sessionAssetId?: string;
  path?: string;
}

export interface ContextTaskFact {
  text: string;
  source: string;
}

export interface ContextTaskRunSummary {
  schemaVersion: 1;
  runId: string;
  workId: string;
  status: "completed" | "failed" | "blocked" | "needs_user_input";
  summary: string;
  completed: string[];
  open: string[];
  actions: string[];
  createdAt: string;
}

export interface ContextCommitSummary {
  commit: string;
  subject: string;
  summary?: string;
  trailers: unknown;
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

export interface ContextEngineMachineContext {
  session: {
    sessionId: string;
    conversationTail: ContextConversationRecord[];
    conversationMarkdownTail?: string;
    eventTail: ContextSessionEventRecord[];
    recentCommits?: ContextCommitSummary[];
    assetCount: number;
  };
  focus: ContextFocus;
  task?: {
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
  nextStep?: string;
  userInputNeeded?: string;
}

export interface HarnessTaskSummaryForContext {
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
}
