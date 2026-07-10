import type { LlmMessage, LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import { correctLocalInputTokenEstimate } from "../../prompt/context-token-counter.js";
import { estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import { projectAgentStateViewForPrompt } from "./prompt-context.js";
import type { AgentPromptStateView } from "./prompt-context.js";
import type { AgentStateView } from "./state-view.js";
import type { ToolContextProjectionPlan } from "./tool-context-projection-planner.js";

export interface ToolContextShadowReceipt extends Omit<ToolContextProjectionPlan, "projectedCalls"> {
  shadowLocalEstimateTokens: number;
  correctedShadowLocalEstimateTokens: number;
}

export function measureToolContextShadowProjection(input: {
  stateView: AgentStateView;
  requestMessages: LlmMessage[];
  turnInput: LlmTurnInput;
  plan: ToolContextProjectionPlan;
  budget: ContextBudgetReport;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): ToolContextShadowReceipt {
  const run = input.stateView.context.run;
  const shadowStateView: AgentStateView = run
    ? {
        ...input.stateView,
        context: {
          ...input.stateView.context,
          run: {
            ...run,
            toolCalls: input.plan.projectedCalls,
          },
        },
      }
    : input.stateView;
  const promptStateView = projectAgentStateViewForPrompt(shadowStateView);
  const shadowTurnInput: LlmTurnInput = {
    ...input.turnInput,
    messages: replaceFirstUserPrompt(input.requestMessages, input.buildPrompt(promptStateView)),
  };
  const shadowLocalEstimateTokens = estimateTurnInputTokens(shadowTurnInput).totalTokens;
  const correctedShadowLocalEstimateTokens = correctLocalInputTokenEstimate(shadowLocalEstimateTokens);
  const measuredSavingsTokens = Math.max(
    0,
    input.budget.correctedLocalEstimateTokens - correctedShadowLocalEstimateTokens,
  );
  const measuredProjectedInputTokens = Math.max(
    0,
    input.budget.measuredInputTokens - measuredSavingsTokens,
  );
  const { projectedCalls: _projectedCalls, ...planReceipt } = input.plan;
  return {
    ...planReceipt,
    estimatedSavingsTokens: measuredSavingsTokens,
    projectedInputTokens: measuredProjectedInputTokens,
    canReachTarget: measuredProjectedInputTokens <= input.budget.recoveryTargetTokens,
    shadowLocalEstimateTokens,
    correctedShadowLocalEstimateTokens,
  };
}

function replaceFirstUserPrompt(messages: LlmMessage[], prompt: string): LlmMessage[] {
  let replaced = false;
  return messages.map((message) => {
    if (replaced || message.role !== "user") return message;
    replaced = true;
    return { role: "user", content: prompt };
  });
}
