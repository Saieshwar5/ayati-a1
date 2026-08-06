import type { LlmProvider } from "../core/contracts/provider.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { CapabilitySurfaceResult } from "./agent-runner/capabilities/contracts.js";
import type { CapabilitySurfaceManager } from "./agent-runner/capabilities/surface-manager.js";
import type { RepairCode, RepairPromptCard } from "./agent-runner/repair-policy.js";
import type { WorkstreamBindingCoordinator } from "./workstream-binding/contracts.js";
import type {
  ArtifactRef,
  AssertionResult,
  ToolDefinition,
  ToolErrorCategory,
  ToolOperationStatus,
  ToolResultV2,
  VerifiedFact,
} from "../skills/types.js";
import type {
  AgentResponseKind,
  AssistantResponseKind,
  FeedbackKind,
  SessionInputHandle,
} from "../memory/types.js";
import type {
  ContextEngineMachineContext,
  ContextRunStepRecord,
} from "../context-engine/index.js";
import type { ContextPreparationManager } from "./context-preparation/manager.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { DirectoryAttachmentRecord, ManagedFileRecord } from "../files/types.js";
import type { AgentEventSink } from "./agent-event-sink.js";
import type { HarnessContext, HarnessContextInput } from "./harness-context.js";
import type { ContextPressureState } from "./context-pressure-state.js";
import type { VirtualModeState } from "./agent-runner/virtual-mode.js";
import type { RunContextProjectionOverlay } from "./agent-runner/run-context-maintenance-contracts.js";
import type {
  HotContextProjection,
  HotContextRuntime,
} from "./hot-context/index.js";
import type { ToolCallVerificationRecord } from "./agent-runner/tool-call-verification-contracts.js";
import type { FilesystemCompletionEvidence } from "./agent-runner/filesystem-completion-evidence-contracts.js";
import type {
  WorkState,
  WorkStateRuntimeMetadata,
  WorkStateUpdateReason,
} from "./agent-runner/work-state/contracts.js";
export type {
  ImportantContextItem,
  ImportantContextKind,
  WorkPlanItem,
  WorkPlanItemStatus,
  WorkState,
  WorkStateRuntimeMetadata,
  WorkStateUpdateInput,
  WorkStateUpdateReason,
  WorkStatus,
} from "./agent-runner/work-state/contracts.js";
import type {
  AgentRunHandle,
  ContextCheckpointPlan,
  ContextCheckpointRecord,
  ContextCheckpointSummary,
  ResourceKind,
  ResourceMetadataStatus,
  ResourceOrigin,
  ResourcePublicLocator,
  ResourceRole,
  RunOutcome,
  RunStopReason,
  VerifiedFilesystemResourceEffect,
  WorkstreamCompletionCriterion,
} from "ayati-context-engine";

export type WorkstreamSummaryRunStatus = "completed" | "failed" | "stuck";
export type WorkstreamSummaryStatus = "open" | "done" | "blocked" | "needs_user_input";
export type WorkstreamSummaryStopReason = "completed" | "needs_user_input" | "blocked" | "failed" | "stuck" | "context_limit" | "run_limit";

export interface WorkstreamSummaryFailureSummary {
  failedStep?: number;
  failedTool?: string;
  failureType?: string;
  error: string;
  retryable: boolean;
  suggestedRecovery?: string;
}

export interface AgentWorkstreamSummaryRecord {
  runId: string;
  runPath: string;
  triggerSeq?: number;
  discussionStartSeq?: number;
  discussionEndSeq?: number;
  runStatus: WorkstreamSummaryRunStatus;
  workstreamStatus?: WorkstreamSummaryStatus;
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
  stopReason?: WorkstreamSummaryStopReason;
  failureSummary?: WorkstreamSummaryFailureSummary;
  attachmentNames?: string[];
}

export interface AgentResourceRecord {
  resourceId: string;
  role: ResourceRole;
  kind: ResourceKind;
  origin: ResourceOrigin;
  displayName: string;
  description: string;
  aliases: string[];
  locator: ResourcePublicLocator;
  metadataStatus?: ResourceMetadataStatus;
}

// --- State ---

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

export type {
  FilesystemCompletionEvidence,
  FilesystemReadCoverage,
  FilesystemReadMode,
} from "./agent-runner/filesystem-completion-evidence-contracts.js";

export interface RunToolCallContext {
  step: number;
  /**
   * Transient context loads have their own ordinal namespace and never refer
   * to a durable run step. Omitted means the call belongs to a durable step.
   */
  stepKind?: "transient_context";
  callId?: string;
  tool: string;
  purpose?: string;
  input: unknown;
  status: "success" | "failed";
  retention?: ToolObservationRetention;
  projectionMetadata?: Record<string, unknown>;
  output: string;
  error?: string;
  code?: string;
  errorCategory?: ToolErrorCategory;
  errorTarget?: string;
  operationStatus?: ToolOperationStatus;
  artifacts?: ArtifactRef[];
  hasMore?: boolean;
  stepRef?: PromptToolCallStepRef;
  evidenceRef?: string;
  rawOutputChars?: number;
  outputTruncated?: boolean;
  verification?: ToolCallVerificationRecord;
  /** Compatibility projection for records created before per-call verification. */
  verificationPassed?: boolean;
  completionEvidence?: FilesystemCompletionEvidence[];
}

export interface ToolContextState {
  recent: ToolObservation[];
  toolCalls?: RunToolCallContext[];
}

export type FailureRepairScope =
  | "navigation"
  | "binding"
  | "action"
  | "validation";

export type FailureResolutionKind =
  | "accepted_mode_transition"
  | "authoritative_binding"
  | "verified_action"
  | "validation_accepted"
  | "denial_reported";

export interface FailureResolution {
  iteration: number;
  kind: FailureResolutionKind;
}

export interface FailureRecord {
  step: number;
  executionContract?: string;
  failureType: "tool_error" | "permission" | "missing_path" | "verify_failed" | "no_progress" | "validation_error";
  reason: string;
  blockedTargets: string[];
  failedCallIds?: string[];
  repairCode?: RepairCode;
  repair?: RepairPromptCard;
  repairScope?: FailureRepairScope;
  resolution?: FailureResolution;
}

export interface ReadProgressState {
  observationalStepCount: number;
  duplicateReadCount: number;
  mutationStepCount: number;
  rejectedReadCount: number;
  signatures: string[];
}

export interface LoopState {
  runId: string;
  currentSeq: number;
  currentMessageId?: string;
  inputKind?: "user_message";
  userMessage: string;
  preferredResponseKind?: AgentResponseKind;
  workState: WorkState;
  workStateRuntime: WorkStateRuntimeMetadata;
  toolContext?: ToolContextState;
  lastCapabilitySurface?: CapabilitySurfaceResult;
  workingNotes?: string[];
  status: "running" | "completed" | "failed" | "stuck";
  finalOutput: string;
  iteration: number;
  maxIterations: number;
  consecutiveFailures: number;
  completedSteps: StepSummary[];
  runPath: string;
  failureHistory: FailureRecord[];
  contextPressure?: ContextPressureState;
  runContextProjection?: RunContextProjectionOverlay;
  runContextMaintenanceBudgetCredits?: number;
  contextLimitReached?: boolean;
  runLimitReached?: boolean;
  interrupted?: boolean;
  readProgress?: ReadProgressState;
  virtualMode: VirtualModeState;
  hotContext: HotContextProjection;
  attachmentWarnings?: string[];
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
  failedCallIds?: string[];
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
  purpose?: string;
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
  verification?: ToolCallVerificationRecord;
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

export type ToolContextProjectionPolicy = "shadow" | "enforce";

export interface LoopConfig {
  maxIterations: number;
  maxConsecutiveFailures: number;
  maxTotalToolCallsPerStep: number;
  maxSequentialToolCallsPerStep: number;
  maxParallelToolCallsPerStep: number;
  maxInlineActOutputChars: number;
  maxVerifyArtifactChars: number;
  maxCapabilitySurfaceTools: number;
  strategyReviewFailureThreshold: number;
  toolContextProjectionPolicy: ToolContextProjectionPolicy;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 30,
  maxConsecutiveFailures: 5,
  maxTotalToolCallsPerStep: 4,
  maxSequentialToolCallsPerStep: 4,
  maxParallelToolCallsPerStep: 3,
  maxInlineActOutputChars: 8_000,
  maxVerifyArtifactChars: 20_000,
  maxCapabilitySurfaceTools: 8,
  strategyReviewFailureThreshold: 3,
  toolContextProjectionPolicy: "enforce",
};

// --- Result + callbacks ---

export interface AgentLoopResult {
  type: AgentResponseKind;
  runId: string;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  content: string;
  status: "completed" | "failed" | "stuck";
  totalIterations: number;
  totalToolCalls: number;
  runPath: string;
  workstreamSummary?: AgentWorkstreamSummaryRecord;
  resources?: AgentResourceRecord[];
  /** Generated filesystem resources confirmed by the passed validation mode. */
  verifiedCompletionResources?: AgentResourceRecord[];
  /** Executor-verified filesystem changes, independent of semantic task validation. */
  verifiedResourceEffects?: VerifiedFilesystemResourceEffect[];
  /** Acceptance criteria paired with exact verified current-run proof. */
  validatedCriteria?: WorkstreamCompletionCriterion[];
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

export interface AgentContextCheckpointCoordinator {
  plan(input: {
    protectFromSeq: number;
    requiredSavingsTokens: number;
    estimatedCheckpointTokens: number;
  }): Promise<ContextCheckpointPlan>;
  commit(input: {
    plan: ContextCheckpointPlan;
    summary: ContextCheckpointSummary;
    tokenCount: number;
    provider: string;
    model: string;
  }): Promise<{
    checkpoint: ContextCheckpointRecord;
    context: ContextEngineMachineContext;
  }>;
  currentContext(): ContextEngineMachineContext;
}

// --- Deps ---

export interface AgentLoopDeps {
  provider: LlmProvider;
  /** Exact runtime-configured Ayati workspace root projected into each primary decision. */
  workspaceRoot?: string;
  toolExecutor?: ToolExecutor;
  capabilitySurfaceManager?: CapabilitySurfaceManager;
  hotContextRuntime?: HotContextRuntime;
  toolDefinitions: ToolDefinition[];
  inputHandle?: SessionInputHandle;
  runHandle: AgentRunHandle;
  clientId: string;
  inputKind?: "user_message";
  preferredResponseKind?: AgentResponseKind;
  initialUserMessage?: string;
  onProgress?: OnProgressCallback;
  onFinalResponseStream?: OnFinalResponseStreamCallback;
  recordRunStep?: (
    record: ContextRunStepRecord,
    currentContext: HarnessContextInput,
  ) => void | HarnessContextInput | Promise<void | HarnessContextInput>;
  checkpointWorkState?: (input: {
    reason: Extract<WorkStateUpdateReason, "plan" | "context_pressure">;
    workState: WorkState;
    runtime: WorkStateRuntimeMetadata;
    afterStep: number;
    at: string;
  }) => Promise<{
    context?: HarnessContextInput;
    runtime: WorkStateRuntimeMetadata;
  }>;
  contextCheckpoint?: AgentContextCheckpointCoordinator;
  /** Runtime-owned disposable context preparation for this run. */
  contextPreparation?: ContextPreparationManager;
  workstreamBinding?: WorkstreamBindingCoordinator;
  eventSink?: AgentEventSink;
  config?: Partial<LoopConfig>;
  dataDir: string;
  systemContext?: string;
  harnessContext?: HarnessContextInput;
  userMessageOverride?: string;
  attachmentWarnings?: string[];
  managedFiles?: ManagedFileRecord[];
  managedDirectories?: DirectoryAttachmentRecord[];
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
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
  messageId?: string;
  content: string;
  attachments?: ChatAttachmentInput[];
}
