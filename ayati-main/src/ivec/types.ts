import type { LlmProvider } from "../core/contracts/provider.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";

// --- State ---

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
}

export interface StepSummary {
  step: number;
  intent: string;
  outcome: string;
  evidence: string;
  summary: string;
  newFacts: string[];
  artifacts: string[];
}

// --- Controller output ---

export interface StepDirective {
  done: false;
  intent: string;
  type: string;
  tools_hint: string[];
  success_criteria: string;
  context: string;
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

export type ControllerOutput = StepDirective | CompletionDirective | SessionRotationDirective;

// --- Phase outputs ---

export interface ReasonOutput {
  thinking: string;
  approach: string;
  potential_issues: string[];
}

export interface ActToolCallRecord {
  tool: string;
  input: unknown;
  output: string;
  error?: string;
}

export interface ActOutput {
  toolCalls: ActToolCallRecord[];
  finalText: string;
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
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 15,
  maxToolCallsPerStep: 4,
  maxConsecutiveFailures: 5,
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
  onProgress?: OnProgressCallback;
  config?: Partial<LoopConfig>;
  dataDir: string;
  systemContext?: string;
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
