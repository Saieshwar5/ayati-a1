import type { LlmProvider } from "../core/contracts/provider.js";
import type { ControllerPrompts } from "../context/types.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import type { SessionMemory, MemoryRunHandle, ConversationTurn, PromptRunLedger } from "../memory/types.js";

// --- State ---

export type TaskStatus = "not_done" | "likely_done" | "done" | "blocked" | "needs_user_input";

export interface GoalContract {
  objective: string;
  done_when: string[];
  required_evidence: string[];
  ask_user_when: string[];
  stop_when_no_progress: string[];
}

export interface ProgressLedger {
  lastSuccessfulStepSummary: string;
  lastStepFacts: string[];
  taskEvidence: string[];
}

export interface FailedApproach {
  step: number;
  intent: string;
  tools_hint: string[];
  failureType: "tool_error" | "permission" | "missing_path" | "verify_failed" | "no_progress" | "validation_error";
  reason: string;
  blockedTargets: string[];
}

export interface LoopState {
  runId: string;
  userMessage: string;
  goal: GoalContract;
  approach: string;
  taskStatus: TaskStatus;
  progressLedger: ProgressLedger;
  status: "running" | "completed" | "failed";
  finalOutput: string;
  iteration: number;
  maxIterations: number;
  consecutiveFailures: number;
  approachChangeCount: number;
  completedSteps: StepSummary[];
  runPath: string;
  failedApproaches: FailedApproach[];
  sessionHistory: ConversationTurn[];
  recentRunLedgers: PromptRunLedger[];
}

export interface StepSummary {
  step: number;
  intent: string;
  outcome: string;
  summary: string;
  newFacts: string[];
  artifacts: string[];
  toolSuccessCount: number;
  toolFailureCount: number;
  taskStatusAfter?: TaskStatus;
  taskReason?: string;
  taskEvidence?: string[];
  stoppedEarlyReason?: "assistant_returned" | "max_act_turns_reached" | "max_total_tool_calls_reached" | "repeated_identical_failure" | "no_valid_tool_calls";
  failureType?: FailedApproach["failureType"];
  blockedTargets?: string[];
}

// --- Controller output ---

export interface UnderstandDirective {
  done: false;
  understand: true;
  goal: GoalContract;
  approach: string;
}

export interface ReEvalDirective {
  done: false;
  reeval: true;
  approach: string;
}

export interface StepDirective {
  done: false;
  execution_mode: "dependent" | "independent";
  intent: string;
  tools_hint: string[];
  success_criteria: string;
  context: string;
}

export interface ContextSearchDirective {
  done: false;
  context_search: true;
  query: string;
  scope: "run_artifacts" | "project_context" | "session" | "skills" | "both";
}

export interface ScoutResult {
  summary: string;
  sources: string[];
  confidence: number;
}

export interface CompletionDirective {
  done: true;
  summary: string;
  status: "completed" | "failed";
}

export interface SessionRotationDirective {
  done: false;
  rotate_session: true;
  reason: string;
  handoff_summary: string;
}

export type ControllerOutput =
  | UnderstandDirective
  | ReEvalDirective
  | StepDirective
  | ContextSearchDirective
  | CompletionDirective
  | SessionRotationDirective;

// --- Phase outputs ---

export interface ActToolCallRecord {
  tool: string;
  input: unknown;
  output: string;
  error?: string;
}

export interface ActOutput {
  toolCalls: ActToolCallRecord[];
  finalText: string;
  stoppedEarlyReason?: "assistant_returned" | "max_act_turns_reached" | "max_total_tool_calls_reached" | "repeated_identical_failure" | "no_valid_tool_calls";
}

export interface VerifyOutput {
  passed: boolean;
  method: "gate" | "llm";
  evidence: string;
  newFacts: string[];
  artifacts: string[];
  taskStatusAfter?: TaskStatus;
  taskReason?: string;
  taskEvidence?: string[];
}

export interface TaskValidationContext {
  userMessage: string;
  goal: GoalContract;
  taskStatus: TaskStatus;
  approach: string;
  latestSuccessfulStepSummary: string;
  latestStepNewFacts: string[];
  recentStepDigests: string[];
}

// --- Config ---

export interface LoopConfig {
  maxIterations: number;
  maxToolCallsPerStep: number;
  maxConsecutiveFailures: number;
  maxApproachChanges: number;
  maxScoutTurns: number;
  maxScoutCallsPerIteration: number;
  maxTotalToolCallsPerStep: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 15,
  maxToolCallsPerStep: 4,
  maxConsecutiveFailures: 5,
  maxApproachChanges: 4,
  maxScoutTurns: 5,
  maxScoutCallsPerIteration: 2,
  maxTotalToolCallsPerStep: 6,
};

// --- Result + callbacks ---

export interface AgentLoopResult {
  type: "reply";
  content: string;
  status: "completed" | "failed" | "stuck";
  totalIterations: number;
  totalToolCalls: number;
  runPath: string;
}

export type OnProgressCallback = (log: string, runPath: string) => void;

// --- Deps ---

export interface AgentLoopDeps {
  provider: LlmProvider;
  toolExecutor?: ToolExecutor;
  toolDefinitions: ToolDefinition[];
  sessionMemory: SessionMemory;
  runHandle: MemoryRunHandle;
  clientId: string;
  initialUserMessage?: string;
  onProgress?: OnProgressCallback;
  config?: Partial<LoopConfig>;
  dataDir: string;
  systemContext?: string;
  controllerPrompts?: ControllerPrompts;
  userMessageOverride?: string;
  signal?: AbortSignal;
  onStuck?: (state: LoopState) => void;
}

export interface ExecutorDeps {
  provider: LlmProvider;
  toolExecutor?: ToolExecutor;
  toolDefinitions: ToolDefinition[];
  config: LoopConfig;
  clientId: string;
  sessionMemory: SessionMemory;
  runHandle: MemoryRunHandle;
  taskContext: TaskValidationContext;
}

export interface ChatAttachmentInput {
  path: string;
  name?: string;
}

export interface ChatInboundMessage {
  type: "chat";
  content: string;
  attachments?: ChatAttachmentInput[];
}
