export type AgentPhase = "reason" | "act" | "verify" | "reflect" | "feedback" | "end";

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
  feedback_message?: string;
  end_status?: EndStatus;
  end_message?: string;
  approaches_tried?: string[];
}

export interface ScratchpadEntry {
  step: number;
  phase: AgentPhase;
  thinking: string;
  summary: string;
  toolResult?: string;
}

export interface RunState {
  step: number;
  scratchpad: ScratchpadEntry[];
  approachesTried: Set<string>;
  toolCallsMade: number;
  toolNamesUsed: Set<string>;
  failedToolCalls: number;
  reflectCycles: number;
  consecutiveNonActSteps: number;
  forceExpandedSelectionNextStep: boolean;
  lastActionSignature?: string;
  consecutiveRepeatedActions: number;
}

export interface ToolSelectionConfig {
  enabled: boolean;
  topK: number;
  retryTopK: number;
  alwaysInclude: string[];
}

export interface EscalationConfig {
  enabled: boolean;
  minToolCalls: number;
  minDistinctTools: number;
  minFailedToolCalls: number;
  minReflectCycles: number;
}

export interface AgentLoopConfig {
  baseStepLimit: number;
  maxStepLimit: number;
  stepLimitPerTool: number;
  noProgressLimit: number;
  repeatedActionLimit: number;
  toolSelection: ToolSelectionConfig;
  escalation: EscalationConfig;
}

export interface AgentLoopConfigInput extends Partial<AgentLoopConfig> {
  toolSelection?: Partial<ToolSelectionConfig>;
  escalation?: Partial<EscalationConfig>;
}

export interface AgentLoopEscalationDetails {
  reason: string;
  summary: string;
  toolNamesUsed: string[];
  failedToolCalls: number;
  reflectCycles: number;
}

export type AgentLoopResultType = "reply" | "feedback" | "escalate";

export interface AgentLoopResult {
  type: AgentLoopResultType;
  content: string;
  endStatus?: EndStatus;
  totalSteps: number;
  toolCallsMade: number;
  escalation?: AgentLoopEscalationDetails;
}

export const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  baseStepLimit: 12,
  maxStepLimit: 20,
  stepLimitPerTool: 2,
  noProgressLimit: 4,
  repeatedActionLimit: 3,
  toolSelection: {
    enabled: true,
    topK: 10,
    retryTopK: 20,
    alwaysInclude: [],
  },
  escalation: {
    enabled: true,
    minToolCalls: 10,
    minDistinctTools: 2,
    minFailedToolCalls: 2,
    minReflectCycles: 2,
  },
};
