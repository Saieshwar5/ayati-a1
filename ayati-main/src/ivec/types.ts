import type { LlmProvider } from "../core/contracts/provider.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";

// --- State ---

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
  goal: string;
  approach: string;
  status: "running" | "completed" | "failed";
  iteration: number;
  maxIterations: number;
  consecutiveFailures: number;
  facts: string[];
  uncertainties: string[];
  completedSteps: StepSummary[];
  runPath: string;
  failedApproaches: FailedApproach[];
}

export interface StepSummary {
  step: number;
  intent: string;
  outcome: string;
  evidence: string;
  summary: string;
  newFacts: string[];
  artifacts: string[];
  toolSuccessCount: number;
  toolFailureCount: number;
  stoppedEarlyReason?: "assistant_returned" | "max_act_turns_reached" | "max_total_tool_calls_reached" | "repeated_identical_failure" | "no_valid_tool_calls";
  actFile?: string;
  verifyFile?: string;
  failureType?: FailedApproach["failureType"];
  blockedTargets?: string[];
}

// --- Controller output ---

export interface ControllerDirectiveUpdates {
  goal_update?: string;
  approach_update?: string;
  approach_change_reason?: string;
}

export interface StepDirective extends ControllerDirectiveUpdates {
  done: false;
  approach: string;
  execution_mode: "dependent" | "independent";
  intent: string;
  type: string;
  tools_hint: string[];
  success_criteria: string;
  context: string;
  inspect_steps?: never;
  inspect_reason?: never;
}

export interface InspectDirective extends ControllerDirectiveUpdates {
  done: false;
  inspect_steps: number[];
  inspect_reason?: string;
  approach?: string;
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

export type ControllerOutput = StepDirective | InspectDirective | CompletionDirective | SessionRotationDirective;

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
}

// --- Config ---

export interface LoopConfig {
  maxIterations: number;
  maxToolCallsPerStep: number;
  maxConsecutiveFailures: number;
  maxInspectRequeriesPerIteration: number;
  maxInspectStepsPerRequest: number;
  maxInspectTotalStepsPerIteration: number;
  maxTotalToolCallsPerStep: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 15,
  maxToolCallsPerStep: 4,
  maxConsecutiveFailures: 5,
  maxInspectRequeriesPerIteration: 4,
  maxInspectStepsPerRequest: 4,
  maxInspectTotalStepsPerIteration: 10,
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
  userMessageOverride?: string;
}

export interface ExecutorDeps {
  provider: LlmProvider;
  toolExecutor?: ToolExecutor;
  toolDefinitions: ToolDefinition[];
  config: LoopConfig;
  clientId: string;
  sessionMemory: SessionMemory;
  runHandle: MemoryRunHandle;
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
