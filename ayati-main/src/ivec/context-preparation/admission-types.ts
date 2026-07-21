import type { ContextCheckpointPlan, ContextCheckpointRecord } from "ayati-context-engine";
import type { LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import type { ContextCompilationReceipt } from "../../prompt/context-compilation-receipt.js";
import type { StreamCheckpointGenerationResult } from "../agent-runner/stream-checkpoint-generator.js";
import type { StreamContextProjectionReceipt } from "../agent-runner/stream-context-projection.js";
import type { ToolContextShadowReceipt } from "../agent-runner/tool-context-shadow.js";
import type { ToolContextProjectionPolicy } from "../types.js";
import type { ContextPreparationEvent } from "./types.js";

export interface DecisionContextCompilation {
  candidateBudget: ContextBudgetReport;
  intermediateBudget: ContextBudgetReport;
  finalBudget: ContextBudgetReport;
  finalTurnInput: LlmTurnInput;
  receipt: ContextCompilationReceipt;
  finalBudgetMeasured: boolean;
  projection?: {
    event: "tool_context_projection_shadow" | "tool_context_projection_enforced";
    policy: ToolContextProjectionPolicy;
    receipt: ToolContextShadowReceipt;
  };
  streamCheckpoint?: {
    plan: ContextCheckpointPlan;
    generation?: StreamCheckpointGenerationResult;
    checkpoint?: ContextCheckpointRecord;
  };
  streamProjection?: StreamContextProjectionReceipt;
  preparationEvents?: ContextPreparationEvent[];
}
