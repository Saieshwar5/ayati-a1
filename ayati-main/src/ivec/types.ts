import type { LlmProvider } from "../core/contracts/provider.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { SkillActivationManager } from "../skills/activation-manager.js";
import type {
  ArtifactRef,
  AssertionResult,
  ToolDefinition,
  ToolOperationStatus,
  ToolResultV2,
  VerifiedFact,
} from "../skills/types.js";
import type { AgentUiContext } from "../ui/context.js";
import type { ActiveAttachmentRef } from "../memory/types.js";
import type {
  AgentResponseKind,
  FeedbackKind,
  SessionMemory,
  MemoryRunHandle,
  ConversationExchange,
  FocusShelfItem,
  PromptTaskSummary,
  TaskSummaryRecordInput,
} from "../memory/types.js";
import type { DocumentStore } from "../documents/document-store.js";
import type { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../documents/types.js";
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
export type RunClass = "interaction" | "task";
export type AgentTaskSummaryRecord = Omit<TaskSummaryRecordInput, "sessionId">;

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

export interface FailureRecord {
  step: number;
  executionContract?: string;
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
  taskProgress: TaskProgressState;
  status: "running" | "completed" | "failed" | "stuck";
  finalOutput: string;
  iteration: number;
  maxIterations: number;
  consecutiveFailures: number;
  completedSteps: StepSummary[];
  runPath: string;
  failureHistory: FailureRecord[];
  attachedDocuments?: ManagedDocumentManifest[];
  attachmentWarnings?: string[];
  preparedAttachments?: PreparedAttachmentSummary[];
  managedFiles?: ManagedFileRecord[];
  managedDirectories?: DirectoryAttachmentRecord[];
  activeSessionAttachments?: ActiveAttachmentRef[];
  activeLearningContext?: string;
  previousSessionSummary?: string;
  personalMemorySnapshot?: string;
  attentionShelf?: FocusShelfItem[];
  recentExchanges: ConversationExchange[];
  recentTaskSummaries: PromptTaskSummary[];
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
  usedRawArtifacts?: string[];
  taskProgress?: TaskProgressState;
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

// --- Config ---

export interface LoopConfig {
  maxIterations: number;
  maxConsecutiveFailures: number;
  maxTotalToolCallsPerStep: number;
  maxInlineActOutputChars: number;
  maxVerifyArtifactChars: number;
  maxSelectedTools: number;
  strategyReviewFailureThreshold: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 15,
  maxConsecutiveFailures: 5,
  maxTotalToolCallsPerStep: 6,
  maxInlineActOutputChars: 8_000,
  maxVerifyArtifactChars: 20_000,
  maxSelectedTools: 12,
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
  taskSummary?: AgentTaskSummaryRecord;
  artifacts?: AgentArtifact[];
}

export type OnProgressCallback = (log: string, runPath: string) => void;

// --- Deps ---

export interface AgentLoopDeps {
  provider: LlmProvider;
  toolExecutor?: ToolExecutor;
  skillActivationManager?: SkillActivationManager;
  toolDefinitions: ToolDefinition[];
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
  activeLearningContext?: string;
  userMessageOverride?: string;
  attachedDocuments?: ManagedDocumentManifest[];
  attachmentWarnings?: string[];
  managedFiles?: ManagedFileRecord[];
  managedDirectories?: DirectoryAttachmentRecord[];
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
