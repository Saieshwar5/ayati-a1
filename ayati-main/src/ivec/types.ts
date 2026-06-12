import type { LlmProvider } from "../core/contracts/provider.js";
import type { ControllerPrompts } from "../context/types.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type {
  ArtifactRef,
  AssertionResult,
  ToolDefinition,
  ToolOperationStatus,
  ToolResultV2,
  VerifiedFact,
} from "../skills/types.js";
import type { AgentUiContext } from "../ui/context.js";
import type { ExternalSkillBroker } from "../skills/external/broker.js";
import type { ExternalSkillRegistry } from "../skills/external/registry.js";
import type { ActiveAttachmentRef } from "../memory/types.js";
import type {
  AgentResponseKind,
  FeedbackKind,
  SessionMemory,
  MemoryRunHandle,
  ConversationTurn,
  PromptTaskSummary,
  SystemActivityItem,
  TaskSummaryRecordInput,
} from "../memory/types.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../documents/types.js";
import type { DocumentContextBackend } from "../documents/document-context-backend.js";
import type { DirectoryAttachmentRecord, ManagedFileRecord } from "../files/types.js";
import type {
  AyatiSystemEvent,
  SystemEventCreatedBy,
  SystemEventIntentKind,
} from "../core/contracts/plugin.js";
import type {
  SystemEventContextVisibility,
  SystemEventHandlingMode,
} from "./system-event-policy.js";
import type { RunMetrics } from "./metrics.js";

export type SystemEventApprovalState = "not_needed" | "pending" | "granted" | "rejected";
export type WorkMode = "background_lookup" | "document_lookup" | "document_process" | "structured_data_process";
export type RunClass = "interaction" | "task";
export type AgentTaskSummaryRecord = Omit<TaskSummaryRecordInput, "sessionId">;
export const RECENT_TASK_SELECTION_LIMIT = 5;
export type PreparedAttachmentStateUpdate =
  | {
    type: "mark_dataset_staged";
    preparedInputId: string;
    staged: true;
    stagingDbPath?: string;
    stagingTableName?: string;
  }
  | {
    type: "mark_document_indexed";
    preparedInputId: string;
    indexed: true;
  }
  | {
    type: "restore_prepared_attachment";
    manifest: ManagedDocumentManifest;
    summary: PreparedAttachmentSummary;
  };

// --- State ---

export type TaskStatus = "not_done" | "likely_done" | "done" | "blocked" | "needs_user_input";

export interface GoalContract {
  objective: string;
  done_when: string[];
  required_evidence: string[];
  ask_user_when: string[];
  stop_when_no_progress: string[];
}

export interface TaskProgressState {
  status: TaskStatus;
  progressSummary: string;
  currentFocus?: string;
  completedMilestones?: string[];
  openWork?: string[];
  blockers?: string[];
  keyFacts: string[];
  evidence: string[];
  userInputNeeded?: string;
}

export interface FailedApproach {
  step: number;
  executionContract?: string;
  intent?: string;
  failureType: "tool_error" | "permission" | "missing_path" | "verify_failed" | "no_progress" | "validation_error";
  reason: string;
  blockedTargets: string[];
}

export interface LoopState {
  runId: string;
  runClass: RunClass;
  inputKind?: "user_message" | "system_event";
  userMessage: string;
  systemEvent?: AyatiSystemEvent;
  originSource?: string;
  systemEventIntentKind?: SystemEventIntentKind;
  systemEventRequestedAction?: string;
  systemEventCreatedBy?: SystemEventCreatedBy;
  handlingMode?: SystemEventHandlingMode;
  approvalRequired?: boolean;
  approvalState?: SystemEventApprovalState;
  contextVisibility?: SystemEventContextVisibility;
  preferredResponseKind?: AgentResponseKind;
  goal: GoalContract;
  approach: string;
  sessionContextSummary: string;
  dependentTask: boolean;
  dependentTaskSummary: PromptTaskSummary | null;
  taskProgress: TaskProgressState;
  status: "running" | "completed" | "failed" | "stuck";
  finalOutput: string;
  iteration: number;
  maxIterations: number;
  consecutiveFailures: number;
  approachChangeCount: number;
  completedSteps: StepSummary[];
  recentContextSearches: RecentContextSearch[];
  runPath: string;
  failedApproaches: FailedApproach[];
  attachedDocuments?: ManagedDocumentManifest[];
  attachmentWarnings?: string[];
  preparedAttachments?: PreparedAttachmentSummary[];
  managedFiles?: ManagedFileRecord[];
  managedDirectories?: DirectoryAttachmentRecord[];
  activeSessionAttachments?: ActiveAttachmentRef[];
  workMode?: WorkMode;
  sessionHistory: ConversationTurn[];
  recentTaskSummaries: PromptTaskSummary[];
  recentSystemActivity: SystemActivityItem[];
}

export interface StepSummary {
  step: number;
  executionContract?: string;
  intent?: string;
  outcome: string;
  summary: string;
  newFacts: string[];
  artifacts: string[];
  toolsUsed?: string[];
  toolSuccessCount: number;
  toolFailureCount: number;
  contractVersion?: 2;
  verificationPolicy?: StepVerificationPolicy;
  verificationRationale?: string;
  expectedArtifacts?: string[];
  expectedStateChange?: string;
  requiresFullStepContext?: boolean;
  expectationCheckStatus?: StepExpectationCheckStatus;
  expectationCheckSummary?: string;
  verificationMethod?: VerificationMethod;
  executionStatus?: VerificationExecutionStatus;
  validationStatus?: VerificationValidationStatus;
  evidenceSummary?: string;
  evidenceItems?: string[];
  usedRawArtifacts?: string[];
  taskProgress?: TaskProgressState;
  stoppedEarlyReason?: "assistant_returned" | "max_act_turns_reached" | "max_total_tool_calls_reached" | "repeated_identical_failure" | "no_valid_tool_calls" | "planned_call_failed";
  failureType?: FailedApproach["failureType"];
  blockedTargets?: string[];
  stateUpdates?: PreparedAttachmentStateUpdate[];
}

// --- Controller output ---

export interface UnderstandDirective {
  done: false;
  understand: true;
  goal: GoalContract;
  approach: string;
  session_context_summary: string;
  dependent_task: boolean;
  dependent_task_slot?: number;
  work_mode?: WorkMode;
}

export interface ReEvalDirective {
  done: false;
  reeval: true;
  approach: string;
}

export interface ReadRunStateDirective {
  done: false;
  read_run_state: true;
  action: "read_summary_window" | "read_step_full";
  window?: {
    from: number;
    to: number;
  };
  step?: number;
  reason?: string;
}

export interface ActivateSkillDirective {
  done: false;
  activate_skill: true;
  skill_id: string;
  reason?: string;
}

export type ExecutionPlanCallOrigin = "builtin" | "external_tool";
export type ExecutionPlanRetryPolicy = "none" | "same_call_once_on_timeout";
export type ExecutionPlanMode = "single" | "sequential" | "parallel" | "autonomous";

export interface ExecutionPlanCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  origin: ExecutionPlanCallOrigin;
  source_refs: string[];
  retry_policy: ExecutionPlanRetryPolicy;
  depends_on: string[];
  purpose: string;
}

export interface ExecutionPlan {
  mode: ExecutionPlanMode;
  calls: ExecutionPlanCall[];
  allowed_tools: string[];
  max_calls?: number;
}

export type StepVerificationPolicy = "deterministic" | "llm" | "script" | "hybrid";
export type StepExpectationCheckStatus = "passed" | "failed" | "invalid" | "skipped";

export interface StepVerificationContract {
  policy: StepVerificationPolicy;
  rationale: string;
  expected_artifacts: string[];
  expected_state_change: string;
  requires_full_step_context: boolean;
}

export interface StepDirective {
  done: false;
  contract_version: 2;
  execution_contract: string;
  execution_plan: ExecutionPlan;
  success_criteria: string;
  context: string;
  verification: StepVerificationContract;
}

export type GenericScoutScope = "run_artifacts" | "project_context" | "session" | "skills" | "both";

export interface ContextSearchDirective {
  done: false;
  context_search: true;
  query: string;
  scope: GenericScoutScope | "documents";
  document_paths?: string[];
}

export type DocumentScoutStatus = "sufficient" | "partial" | "empty" | "unavailable";

export type RecentContextSearchStatus = "success" | DocumentScoutStatus;

export interface RecentContextSearch {
  scope: ContextSearchDirective["scope"];
  query: string;
  status: RecentContextSearchStatus;
  context: string;
  sources: string[];
  confidence: number;
  iteration: number;
}

export interface DocumentScoutState {
  status: DocumentScoutStatus;
  insufficientEvidence: boolean;
  warnings: string[];
}

export type GenericScoutStatus = "empty" | "max_turns_exhausted";

export interface GenericScoutState {
  status: GenericScoutStatus;
  scope: GenericScoutScope;
  query: string;
  searchedLocations: string[];
  attemptedSearches: string[];
  errors: string[];
}

export interface ScoutResult {
  context: string;
  sources: string[];
  confidence: number;
  documentState?: DocumentScoutState;
  scoutState?: GenericScoutState;
}

export interface CompletionDirective {
  done: true;
  summary: string;
  status: "completed" | "failed";
  response_kind?: AgentResponseKind;
  feedback_kind?: FeedbackKind;
  feedback_label?: string;
  action_type?: string;
  entity_hints?: string[];
}

export type ControllerOutput =
  | UnderstandDirective
  | ReEvalDirective
  | ReadRunStateDirective
  | ActivateSkillDirective
  | StepDirective
  | ContextSearchDirective
  | CompletionDirective;

// --- Phase outputs ---

export interface ActToolCallRecord {
  tool: string;
  input: unknown;
  output: string;
  outputStorage?: "inline" | "raw_file";
  rawOutputPath?: string;
  rawOutputChars?: number;
  outputTruncated?: boolean;
  error?: string;
  meta?: Record<string, unknown>;
  result?: ToolResultV2;
  operationStatus?: ToolOperationStatus;
  code?: string;
  artifacts?: ArtifactRef[];
  verifiedFacts?: VerifiedFact[];
  assertionResults?: AssertionResult[];
}

export interface ActOutput {
  toolCalls: ActToolCallRecord[];
  finalText: string;
  stoppedEarlyReason?: "assistant_returned" | "max_act_turns_reached" | "max_total_tool_calls_reached" | "repeated_identical_failure" | "no_valid_tool_calls" | "planned_call_failed";
}

export type VerificationMethod = "execution_gate" | "llm" | "script";
export type VerificationExecutionStatus = "no_tools" | "all_succeeded" | "partial_success" | "all_failed";
export type VerificationValidationStatus = "passed" | "failed" | "skipped";

export interface VerifyOutput {
  passed: boolean;
  method: VerificationMethod;
  executionStatus: VerificationExecutionStatus;
  validationStatus: VerificationValidationStatus;
  summary: string;
  evidenceSummary: string;
  evidenceItems: string[];
  newFacts: string[];
  artifacts: string[];
  usedRawArtifacts: string[];
  expectationCheckStatus?: StepExpectationCheckStatus;
  expectationCheckSummary?: string;
  taskProgress?: TaskProgressState;
}

export interface AgentArtifact {
  kind: "image";
  name: string;
  relativePath: string;
  urlPath: string;
  mimeType: string;
  sizeBytes?: number;
}

export interface TaskValidationContext {
  inputKind?: "user_message" | "system_event";
  userMessage: string;
  systemEvent?: AyatiSystemEvent;
  originSource?: string;
  systemEventIntentKind?: SystemEventIntentKind;
  systemEventRequestedAction?: string;
  systemEventCreatedBy?: SystemEventCreatedBy;
  handlingMode?: SystemEventHandlingMode;
  approvalRequired?: boolean;
  approvalState?: SystemEventApprovalState;
  goal: GoalContract;
  approach: string;
  previousTaskProgress: TaskProgressState;
  recentSuccessfulSteps: Array<{
    step: number;
    executionContract: string;
    summary: string;
    evidenceItems: string[];
    taskFacts: string[];
    artifacts: string[];
  }>;
  recentFailedSteps: Array<{
    step: number;
    executionContract: string;
    summary: string;
    evidenceItems: string[];
    taskFacts: string[];
    artifacts: string[];
    blockedTargets: string[];
    failureType?: FailedApproach["failureType"];
  }>;
  latestSuccessfulStep: {
    summary: string;
    evidenceItems: string[];
    taskFacts: string[];
    artifacts: string[];
  };
  recentSuccessfulSummaries: string[];
}

// --- Config ---

export interface LoopConfig {
  harnessVersion: "v1" | "v2";
  maxIterations: number;
  maxToolCallsPerStep: number;
  maxConsecutiveFailures: number;
  approachReevalThreshold: number;
  maxApproachChanges: number;
  maxScoutTurns: number;
  maxScoutCallsPerIteration: number;
  maxTotalToolCallsPerStep: number;
  maxInlineActOutputChars: number;
  maxVerifyArtifactChars: number;
  v2MaxSelectedTools: number;
  v2StrategyReviewFailureThreshold: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  harnessVersion: "v1",
  maxIterations: 15,
  maxToolCallsPerStep: 4,
  maxConsecutiveFailures: 5,
  approachReevalThreshold: 3,
  maxApproachChanges: 4,
  maxScoutTurns: 10,
  maxScoutCallsPerIteration: 4,
  maxTotalToolCallsPerStep: 6,
  maxInlineActOutputChars: 8_000,
  maxVerifyArtifactChars: 20_000,
  v2MaxSelectedTools: 12,
  v2StrategyReviewFailureThreshold: 3,
};

// --- Result + callbacks ---

export interface AgentLoopResult {
  type: AgentResponseKind;
  runClass: RunClass;
  content: string;
  status: "completed" | "failed" | "stuck";
  totalIterations: number;
  totalToolCalls: number;
  runPath: string;
  taskSummary?: AgentTaskSummaryRecord;
  artifacts?: AgentArtifact[];
}

export type OnProgressCallback = (log: string, runPath: string) => void;

// --- Deps ---

export interface AgentLoopDeps {
  provider: LlmProvider;
  toolExecutor?: ToolExecutor;
  toolDefinitions: ToolDefinition[];
  externalSkillBroker?: ExternalSkillBroker;
  externalSkillRegistry?: ExternalSkillRegistry;
  sessionMemory: SessionMemory;
  runHandle: MemoryRunHandle;
  clientId: string;
  inputKind?: "user_message" | "system_event";
  systemEvent?: AyatiSystemEvent;
  systemEventIntentKind?: SystemEventIntentKind;
  systemEventRequestedAction?: string;
  systemEventCreatedBy?: SystemEventCreatedBy;
  systemEventHandlingMode?: SystemEventHandlingMode;
  systemEventApprovalRequired?: boolean;
  systemEventApprovalState?: SystemEventApprovalState;
  systemEventContextVisibility?: SystemEventContextVisibility;
  preferredResponseKind?: AgentResponseKind;
  initialUserMessage?: string;
  uiContext?: AgentUiContext;
  onProgress?: OnProgressCallback;
  config?: Partial<LoopConfig>;
  dataDir: string;
  systemContext?: string;
  controllerSystemContext?: string;
  controllerPrompts?: ControllerPrompts;
  userMessageOverride?: string;
  attachedDocuments?: ManagedDocumentManifest[];
  attachmentWarnings?: string[];
  managedFiles?: ManagedFileRecord[];
  managedDirectories?: DirectoryAttachmentRecord[];
  documentStore?: DocumentStore;
  preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  documentContextBackend?: DocumentContextBackend;
  signal?: AbortSignal;
  onStuck?: (state: LoopState) => void;
}

export interface ExecutorDeps {
  provider: LlmProvider;
  toolExecutor?: ToolExecutor;
  toolDefinitions: ToolDefinition[];
  externalSkillBroker?: ExternalSkillBroker;
  externalSkillRegistry?: ExternalSkillRegistry;
  config: LoopConfig;
  clientId: string;
  uiContext?: AgentUiContext;
  sessionMemory: SessionMemory;
  runHandle: MemoryRunHandle;
  taskContext: TaskValidationContext;
  metrics?: RunMetrics;
}

export interface CliChatAttachmentInput {
  type?: "file";
  source?: "cli";
  path: string;
  name?: string;
}

export interface DirectoryChatAttachmentInput {
  type: "directory";
  source?: "cli";
  path: string;
  name?: string;
  include?: string[];
  exclude?: string[];
  maxDepth?: number;
  maxFiles?: number;
}

export interface UploadedChatAttachmentInput {
  type?: "upload";
  source: "upload";
  uploadedPath: string;
  originalName: string;
  mimeType?: string;
  sizeBytes?: number;
  fileId?: string;
}

export interface ManagedFileChatAttachmentInput {
  type?: "managed_file" | "file";
  source?: "file";
  fileId: string;
}

export type ChatAttachmentInput =
  | CliChatAttachmentInput
  | DirectoryChatAttachmentInput
  | UploadedChatAttachmentInput
  | ManagedFileChatAttachmentInput;

export interface ChatInboundMessage {
  type: "chat";
  content: string;
  attachments?: ChatAttachmentInput[];
  uiContext?: AgentUiContext;
}
