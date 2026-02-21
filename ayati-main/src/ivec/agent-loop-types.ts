export type AgentPhase = "reason" | "plan" | "act" | "verify" | "reflect" | "feedback" | "end";

export type EndStatus = "solved" | "partial" | "stuck";

export interface AgentStepAction {
  tool_name: string;
  tool_input: unknown;
}

export interface AgentStepInput {
  phase: AgentPhase;
  thinking: string;
  summary: string;
  action?: AgentStepAction;
  plan?: {
    goal: string;
    sub_tasks: Array<{
      id: number;
      title: string;
      depends_on?: number[];
    }>;
  };
  key_facts?: string[];
  sub_task_outcome?: "done" | "failed";
  feedback_message?: string;
  end_status?: EndStatus;
  end_message?: string;
}

export interface RunState {
  step: number;
  phaseHistory: AgentPhase[];
  toolCallsMade: number;
  toolNamesUsed: Set<string>;
  failedToolCalls: number;
  consecutiveNonActSteps: number;
  lastActionSignature?: string;
  consecutiveRepeatedActions: number;
  errorsByCategory: Map<string, number>;
  hasPlan: boolean;
  currentSubTaskId: number | null;
  autoRotated: boolean;
}

export interface AgentLoopConfig {
  baseStepLimit: number;
  maxStepLimit: number;
  stepLimitPerTool: number;
  noProgressLimit: number;
  repeatedActionLimit: number;
  contextTokenLimit: number;
  autoRotateThreshold: number;
}

export type AgentLoopConfigInput = Partial<AgentLoopConfig>;

export type AgentLoopResultType = "reply" | "feedback";

export interface AgentLoopResult {
  type: AgentLoopResultType;
  content: string;
  endStatus?: EndStatus;
  totalSteps: number;
  toolCallsMade: number;
  workingMemoryPath?: string;
  runDigest?: import("../memory/run-working-memory.js").RunDigest;
}

export const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  baseStepLimit: 12,
  maxStepLimit: 20,
  stepLimitPerTool: 2,
  noProgressLimit: 4,
  repeatedActionLimit: 3,
  contextTokenLimit: 100_000,
  autoRotateThreshold: 90,
};
