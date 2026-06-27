import type {
  CompletePreparedRunInput,
  CompletedPreparedRun,
  DailySessionMachineContextPack,
  RunId,
  SessionId,
  TaskAssetRecord,
  WorkId,
} from "./daily-session/index.js";

export type ContextEngineMachineContext = DailySessionMachineContextPack;
export type CommitContextRunInput = CompletePreparedRunInput;
export type CommittedContextRun = CompletedPreparedRun;

export interface PrepareContextUserTurnInput {
  userMessage: string;
  at?: string;
  sessionId?: SessionId;
  timezone?: string;
}

export interface ContextEngineReadyTurn {
  status: "ready";
  sessionId: SessionId;
  runId: RunId;
  workId: WorkId;
  ref: string;
  context: ContextEngineMachineContext;
}

export interface ContextEngineAmbiguousTurn {
  status: "ambiguous";
  sessionId: SessionId;
  context: ContextEngineMachineContext;
  message: string;
  candidateCount?: number;
}

export type ContextEnginePreparedTurn =
  | ContextEngineReadyTurn
  | ContextEngineAmbiguousTurn;

export interface RecordContextAssistantMessageInput {
  sessionId: SessionId;
  text: string;
  at?: string;
}

export interface ContextEngineRuntime {
  prepareUserTurn(input: PrepareContextUserTurnInput): Promise<ContextEnginePreparedTurn>;
  completePreparedRun(input: CommitContextRunInput): Promise<CommittedContextRun>;
  recordAssistantMessage(input: RecordContextAssistantMessageInput): Promise<void>;
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
