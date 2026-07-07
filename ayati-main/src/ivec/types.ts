import type { LlmProvider } from "../core/contracts/provider.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { SkillActivationManager } from "../skills/activation-manager.js";
import type { ToolLoadResult, ToolWorkingSetManager } from "./agent-runner/tool-working-set.js";
import type { RepairCode, RepairPromptCard } from "./agent-runner/repair-policy.js";
import type {
  ArtifactRef,
  AssertionResult,
  ToolDefinition,
  ToolOperationStatus,
  ToolResultV2,
  VerifiedFact,
} from "../skills/types.js";
import type { AgentUiContext } from "../ui/context.js";
import type {
  AgentResponseKind,
  AssistantResponseKind,
  FeedbackKind,
  MemoryRunHandle,
  RunRecorder,
  SessionInputHandle,
} from "../memory/types.js";
import type { GitMemoryStepRecord, TaskAssetRecord } from "../context-engine/index.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { PreparedAttachmentRecord, PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../documents/types.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
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
import type { AgentFeedbackLedger } from "./feedback-ledger.js";
import type { HarnessContext, HarnessContextInput } from "./harness-context.js";

export type SystemEventApprovalState = "not_needed" | "pending" | "granted" | "rejected";
export type RunClass = "interaction" | "task";
export type TaskSummaryRunStatus = "completed" | "failed" | "stuck";
export type TaskSummaryTaskStatus = "open" | "done" | "blocked" | "needs_user_input";
export type TaskSummaryStopReason = "completed" | "needs_user_input" | "blocked" | "failed" | "stuck";

export interface TaskSummaryFailureSummary {
  failedStep?: number;
  failedTool?: string;
  failureType?: string;
  error: string;
  retryable: boolean;
  suggestedRecovery?: string;
}

export interface AgentTaskSummaryRecord {
  runId: string;
  runPath: string;
  triggerSeq?: number;
  discussionStartSeq?: number;
  discussionEndSeq?: number;
  runStatus: TaskSummaryRunStatus;
  taskStatus?: TaskSummaryTaskStatus;
  objective?: string;
  summary: string;
  progressSummary?: string;
  currentFocus?: string;
  completedMilestones?: string[];
  assumptions?: string[];
  constraints?: string[];
  openWork?: string[];
  blockers?: string[];
  keyFacts?: string[];
  evidence?: string[];
  userInputNeeded?: string;
  userMessage?: string;
  assistantResponse?: string;
  assistantResponseKind?: AssistantResponseKind;
  feedbackKind?: FeedbackKind;
  feedbackLabel?: string;
  actionType?: string;
  entityHints?: string[];
  toolsUsed?: string[];
  goalDoneWhen?: string[];
  goalRequiredEvidence?: string[];
  nextAction?: string;
  stopReason?: TaskSummaryStopReason;
  failureSummary?: TaskSummaryFailureSummary;
  attachmentNames?: string[];
}

// --- State ---

export type WorkStatus = "not_done" | "done" | "blocked" | "needs_user_input";

export type ToolAvailableAction = "search" | "read_range" | "read_next_range" | "inspect" | "rerun_narrower" | "list_narrower";
export type ToolObservationMode = "full" | "focused" | "chunk" | "large_ref" | "summary";
export type ToolObservationRetention = "next_step" | "while_relevant" | "evidence_only";
export type ToolObservationStatus = "success" | "failed";

export interface ToolObservation {
  id: string;
  step: number;
  callId: string;
  tool: string;
  purpose?: string;
  status: ToolObservationStatus;
  mode: ToolObservationMode;
  retention: ToolObservationRetention;
  content: string;
  evidenceRef?: string;
  sourceEvidenceRef?: string;
  rawOutputChars?: number;
  lineCount?: number;
  hasMore: boolean;
  cursor?: {
    currentRange: [number, number];
    nextOffset?: number;
  };
  availableActions?: ToolAvailableAction[];
}

export interface PromptToolCallStepRef {
  runId: string;
  step: number;
  callId?: string;
}

export interface PromptToolCallContext {
  step: number;
  callId?: string;
  tool: string;
  input: unknown;
  status: "success" | "failed";
  output: string;
  error?: string;
  code?: string;
  operationStatus?: ToolOperationStatus;
  artifacts?: ArtifactRef[];
  hasMore?: boolean;
  stepRef?: PromptToolCallStepRef;
  evidenceRef?: string;
  rawOutputChars?: number;
  outputTruncated?: boolean;
}

export interface ToolContextState {
  recent: ToolObservation[];
  toolCalls?: PromptToolCallContext[];
}

export interface TaskNote {
  id: string;
  text: string;
  source: string;
  expires: "next_step" | "task";
}

export interface WorkState {
  status: WorkStatus;
  summary: string;
  openWork?: string[];
  blockers?: string[];
  verifiedFacts: string[];
  evidence: string[];
  artifacts?: string[];
  taskNotes?: TaskNote[];
  nextStep?: string;
  userInputNeeded?: string;
}

export interface FailureRecord {
  step: number;
  executionContract?: string;
  failureType: "tool_error" | "permission" | "missing_path" | "verify_failed" | "no_progress" | "validation_error";
  reason: string;
  blockedTargets: string[];
  repairCode?: RepairCode;
  repair?: RepairPromptCard;
}

export interface ReadProgressState {
  readOnlyStepCount: number;
  duplicateReadCount: number;
  mutationStepCount: number;
  rejectedReadCount: number;
  signatures: string[];
}

export interface LoopState {
  runId: string;
  currentSeq: number;
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
  workState: WorkState;
  toolContext?: ToolContextState;
  lastToolLoad?: ToolLoadResult;
  workingNotes?: string[];
  status: "running" | "completed" | "failed" | "stuck";
  finalOutput: string;
  iteration: number;
  maxIterations: number;
  consecutiveFailures: number;
  completedSteps: StepSummary[];
  runPath: string;
  failureHistory: FailureRecord[];
  readProgress?: ReadProgressState;
  attachedDocuments?: ManagedDocumentManifest[];
  attachmentWarnings?: string[];
  preparedAttachments?: PreparedAttachmentSummary[];
  preparedAttachmentRecords?: PreparedAttachmentRecord[];
  managedFiles?: ManagedFileRecord[];
  managedDirectories?: DirectoryAttachmentRecord[];
  harnessContext: HarnessContext;
}

export type StepVerificationPolicy = "deterministic" | "llm" | "script" | "hybrid";
export type StepExpectationCheckStatus = "passed" | "failed" | "invalid" | "skipped";

export interface StepSummary {
  step: number;
  executionContract?: string;
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
  evidenceSource?: Record<string, unknown>;
  outputSize?: number;
  lineCount?: number;
  truncated?: boolean;
  usedRawArtifacts?: string[];
  workState?: WorkState;
  stoppedEarlyReason?: "assistant_returned" | "max_act_turns_reached" | "max_total_tool_calls_reached" | "repeated_identical_failure" | "no_valid_tool_calls" | "planned_call_failed";
  failureType?: FailureRecord["failureType"];
  blockedTargets?: string[];
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

// --- Phase outputs ---

export interface ActToolCallRecord {
  callId?: string;
  tool: string;
  input: unknown;
  output: string;
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
  observation?: ToolObservation;
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
  workState?: WorkState;
}

export interface AgentArtifact {
  kind: "image";
  name: string;
  relativePath: string;
  urlPath: string;
  mimeType: string;
  sizeBytes?: number;
}

// --- Config ---

export interface LoopConfig {
  maxIterations: number;
  maxConsecutiveFailures: number;
  maxTotalToolCallsPerStep: number;
  maxSequentialToolCallsPerStep: number;
  maxParallelToolCallsPerStep: number;
  maxInlineActOutputChars: number;
  maxVerifyArtifactChars: number;
  maxSelectedTools: number;
  strategyReviewFailureThreshold: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 20,
  maxConsecutiveFailures: 5,
  maxTotalToolCallsPerStep: 4,
  maxSequentialToolCallsPerStep: 4,
  maxParallelToolCallsPerStep: 3,
  maxInlineActOutputChars: 8_000,
  maxVerifyArtifactChars: 20_000,
  maxSelectedTools: 15,
  strategyReviewFailureThreshold: 3,
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
  workRunId?: string;
  taskSummary?: AgentTaskSummaryRecord;
  taskAssets?: TaskAssetRecord[];
  artifacts?: AgentArtifact[];
  workState?: WorkState;
  completedSteps?: StepSummary[];
  harnessContext?: HarnessContext;
}

export type OnProgressCallback = (log: string, runPath: string) => void;
export type FinalResponseStreamKind = "reply" | "feedback" | "notification";
export type FinalResponseStreamEvent =
  | {
      type: "start";
      kind: FinalResponseStreamKind;
    }
  | {
      type: "delta";
      delta: string;
    };
export type OnFinalResponseStreamCallback = (event: FinalResponseStreamEvent) => void;

export interface CreateWorkRunRequest {
  reason: string;
  userMessage: string;
  activeTaskId?: string;
  activeBranch?: string;
}

export interface CreatedWorkRun {
  runHandle: MemoryRunHandle;
  harnessContext?: HarnessContextInput;
}

export type CreateWorkRunResult = MemoryRunHandle | CreatedWorkRun;

// --- Deps ---

export interface AgentLoopDeps {
  provider: LlmProvider;
  toolExecutor?: ToolExecutor;
  skillActivationManager?: SkillActivationManager;
  toolWorkingSetManager?: ToolWorkingSetManager;
  toolDefinitions: ToolDefinition[];
  runRecorder?: RunRecorder;
  inputHandle?: SessionInputHandle;
  runHandle?: MemoryRunHandle;
  createWorkRun?: (
    inputHandle: SessionInputHandle,
    request: CreateWorkRunRequest,
  ) => CreateWorkRunResult | Promise<CreateWorkRunResult>;
  onWorkRunCreated?: (runHandle: MemoryRunHandle) => void;
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
  onFinalResponseStream?: OnFinalResponseStreamCallback;
  recordTaskStep?: (record: GitMemoryStepRecord) => void;
  feedbackLedger?: AgentFeedbackLedger;
  config?: Partial<LoopConfig>;
  dataDir: string;
  systemContext?: string;
  harnessContext?: HarnessContextInput;
  userMessageOverride?: string;
  attachedDocuments?: ManagedDocumentManifest[];
  attachmentWarnings?: string[];
  managedFiles?: ManagedFileRecord[];
  managedDirectories?: DirectoryAttachmentRecord[];
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
  documentStore?: DocumentStore;
  preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  signal?: AbortSignal;
  onStuck?: (state: LoopState) => void;
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
