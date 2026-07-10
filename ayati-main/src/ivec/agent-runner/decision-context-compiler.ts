import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import {
  buildFullContextCompilationReceipt,
  buildToolCompactContextCompilationReceipt,
} from "../../prompt/context-compilation-receipt.js";
import type { ContextCompilationReceipt } from "../../prompt/context-compilation-receipt.js";
import { measureTurnContext } from "../../prompt/context-token-counter.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type { ToolContextProjectionPolicy } from "../types.js";
import type { AgentPromptStateView } from "./prompt-context.js";
import type { AgentStateView } from "./state-view.js";
import { planToolContextProjection } from "./tool-context-projection-planner.js";
import { buildToolContextProjectionCandidate } from "./tool-context-shadow.js";
import type { ToolContextShadowReceipt } from "./tool-context-shadow.js";

export interface DecisionContextCompilation {
  candidateBudget: ContextBudgetReport;
  finalBudget: ContextBudgetReport;
  finalTurnInput: LlmTurnInput;
  receipt: ContextCompilationReceipt;
  finalBudgetMeasured: boolean;
  projection?: {
    event: "tool_context_projection_shadow" | "tool_context_projection_enforced";
    policy: ToolContextProjectionPolicy;
    receipt: ToolContextShadowReceipt;
  };
}

export async function compileDecisionContext(input: {
  provider: LlmProvider;
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  contextLimits: ResolvedModelContextLimits;
  decisionAttempt: number;
  policy: ToolContextProjectionPolicy;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): Promise<DecisionContextCompilation> {
  const candidateBudget = await measureTurnContext({
    provider: input.provider,
    turnInput: input.turnInput,
    limits: input.contextLimits,
  });
  const plan = planToolContextProjection({
    calls: input.stateView.context.run?.toolCalls ?? [],
    candidateInputTokens: candidateBudget.measuredInputTokens,
    recoveryTargetTokens: candidateBudget.recoveryTargetTokens,
    softInputTokens: candidateBudget.softInputTokens,
  });

  if (!plan.triggered) {
    return fullCompilation(input.turnInput, candidateBudget, input.decisionAttempt);
  }

  const projection = buildToolContextProjectionCandidate({
    stateView: input.stateView,
    requestMessages: input.turnInput.messages,
    turnInput: input.turnInput,
    plan,
    budget: candidateBudget,
    buildPrompt: input.buildPrompt,
  });
  const projectionEvent: "tool_context_projection_shadow" | "tool_context_projection_enforced" =
    input.policy === "enforce"
      ? "tool_context_projection_enforced"
      : "tool_context_projection_shadow";
  const transformations = plan.calls
    .filter((call) => call.mode !== "full")
    .map((call) => ({
      kind: "tool_call_projection",
      ...(call.callId ? { callId: call.callId } : {}),
      tool: call.tool,
      ...(call.projectorId ? { projectorId: call.projectorId } : {}),
      from: "full",
      to: call.mode,
      reason: call.reason,
      tokensBefore: call.tokensBefore,
      tokensAfter: call.tokensAfter,
    }));
  const projectionResult = {
    event: projectionEvent,
    policy: input.policy,
    receipt: projection.receipt,
  };

  if (input.policy !== "enforce" || transformations.length === 0) {
    const compilation = fullCompilation(input.turnInput, candidateBudget, input.decisionAttempt);
    return {
      ...compilation,
      receipt: {
        ...compilation.receipt,
        toolProjectionPolicy: input.policy,
        ...(input.policy === "enforce" ? {
          targetReached: candidateBudget.measuredInputTokens <= candidateBudget.recoveryTargetTokens,
          needsEscalation: candidateBudget.measuredInputTokens > candidateBudget.recoveryTargetTokens,
        } : {}),
      },
      projection: projectionResult,
    };
  }

  const finalBudget = await measureTurnContext({
    provider: input.provider,
    turnInput: projection.turnInput,
    limits: input.contextLimits,
  });
  return {
    candidateBudget,
    finalBudget,
    finalTurnInput: projection.turnInput,
    finalBudgetMeasured: true,
    receipt: buildToolCompactContextCompilationReceipt({
      candidate: candidateBudget,
      final: finalBudget,
      decisionAttempt: input.decisionAttempt,
      transformations,
    }),
    projection: projectionResult,
  };
}

function fullCompilation(
  turnInput: LlmTurnInput,
  budget: ContextBudgetReport,
  decisionAttempt: number,
): DecisionContextCompilation {
  return {
    candidateBudget: budget,
    finalBudget: budget,
    finalTurnInput: turnInput,
    finalBudgetMeasured: false,
    receipt: buildFullContextCompilationReceipt(budget, decisionAttempt),
  };
}
