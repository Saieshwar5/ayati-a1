import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmMessage, LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import type {
  ContextCompilationMode,
  ContextCompilationReceipt,
} from "../../prompt/context-compilation-receipt.js";
import { correctLocalInputTokenEstimate, measureTurnContext } from "../../prompt/context-token-counter.js";
import { estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type { AgentPromptStateView } from "../agent-runner/prompt-context.js";
import type { AgentStateView } from "../agent-runner/state-view.js";
import type { StreamContextProjectionReceipt } from "../agent-runner/stream-context-projection.js";
import { planToolContextProjection } from "../agent-runner/tool-context-projection-planner.js";
import { buildToolContextProjectionCandidate } from "../agent-runner/tool-context-shadow.js";
import type { DecisionContextCompilation } from "./admission-types.js";
import {
  applyDeterministicContextBounds,
  removeDuplicateAndInvalidContext,
} from "./deterministic-reduction.js";

export interface MainDeterministicRecoveryResult {
  stateView: AgentPromptStateView;
  turnInput: LlmTurnInput;
  intermediateBudget: ContextBudgetReport;
  finalBudget: ContextBudgetReport;
  transformations: ContextCompilationReceipt["transformations"];
  projection?: DecisionContextCompilation["projection"];
  streamProjection?: StreamContextProjectionReceipt;
  mode: ContextCompilationMode;
  measured: boolean;
}

export async function recoverMainContextDeterministically(input: {
  provider: LlmProvider;
  contextLimits: ResolvedModelContextLimits;
  stateView: AgentPromptStateView;
  turnInput: LlmTurnInput;
  budget: ContextBudgetReport;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): Promise<MainDeterministicRecoveryResult> {
  let stateView = input.stateView;
  let turnInput = input.turnInput;
  let budget = input.budget;
  let intermediateBudget = budget;
  let measured = false;
  let mode: ContextCompilationMode = "full";
  const transformations: ContextCompilationReceipt["transformations"] = [];
  let projection: DecisionContextCompilation["projection"];

  const cleaned = removeDuplicateAndInvalidContext(stateView);
  if (cleaned.removedDuplicateCount > 0 || cleaned.removedInvalidObservationCount > 0) {
    const before = budget.measuredInputTokens;
    stateView = cleaned.stateView;
    turnInput = rebuildTurnInput(turnInput, stateView, input.buildPrompt);
    budget = await measure(input, turnInput);
    measured = true;
    mode = "stream_project";
    transformations.push({
      kind: "deduplicate_and_invalidate",
      from: "unvalidated_projection",
      to: "stable_valid_projection",
      reason: `duplicates=${cleaned.removedDuplicateCount};invalid=${cleaned.removedInvalidObservationCount}`,
      tokensBefore: before,
      tokensAfter: budget.measuredInputTokens,
    });
  }

  const toolPlan = planToolContextProjection({
    calls: stateView.context.run?.toolCalls ?? [],
    candidateInputTokens: budget.measuredInputTokens,
    recoveryTargetTokens: budget.recoveryTargetTokens,
    softInputTokens: budget.softInputTokens,
  });
  const toolTransformations = toolPlan.calls.filter((call) => call.mode !== "full");
  if (toolTransformations.length > 0) {
    const before = budget.measuredInputTokens;
    const projected = buildToolContextProjectionCandidate({
      stateView: stateView as AgentStateView,
      requestMessages: turnInput.messages,
      turnInput,
      plan: toolPlan,
      budget,
      buildPrompt: input.buildPrompt,
    });
    const run = stateView.context.run;
    stateView = run ? {
      ...stateView,
      context: {
        ...stateView.context,
        run: { ...run, toolCalls: toolPlan.projectedCalls },
      },
    } : stateView;
    turnInput = projected.turnInput;
    budget = await measure(input, turnInput);
    intermediateBudget = budget;
    measured = true;
    mode = "tool_compact";
    projection = {
      event: "tool_context_projection_enforced",
      policy: "enforce",
      receipt: projected.receipt,
    };
    transformations.push(...toolTransformations.map((call) => ({
      kind: "tool_call_projection",
      ...(call.callId ? { callId: call.callId } : {}),
      tool: call.tool,
      ...(call.projectorId ? { projectorId: call.projectorId } : {}),
      from: "full",
      to: call.mode,
      reason: call.reason,
      tokensBefore: call.tokensBefore,
      tokensAfter: call.tokensAfter,
    })));
    if (before === budget.measuredInputTokens) intermediateBudget = input.budget;
  }

  const bounded = applyDeterministicContextBounds(stateView);
  const removedBounds = bounded.removedCandidateCount
    + bounded.removedRecentWorkCount
    + bounded.removedResourceCount
    + bounded.removedObservationCount;
  let streamProjection: StreamContextProjectionReceipt | undefined;
  if (removedBounds > 0) {
    const before = budget.measuredInputTokens;
    stateView = bounded.stateView;
    turnInput = rebuildTurnInput(turnInput, stateView, input.buildPrompt);
    budget = await measure(input, turnInput);
    measured = true;
    mode = "stream_project";
    const estimate = estimateTurnInputTokens(turnInput).totalTokens;
    streamProjection = {
      schemaVersion: 1,
      triggered: true,
      removedCandidateCount: bounded.removedCandidateCount,
      removedRecentWorkCount: bounded.removedRecentWorkCount,
      removedResourceCount: bounded.removedResourceCount,
      removedObservationCount: bounded.removedObservationCount,
      localEstimateTokens: estimate,
      correctedLocalEstimateTokens: correctLocalInputTokenEstimate(estimate),
    };
    transformations.push({
      kind: "bounded_context_projection",
      from: "unbounded_referenceable_context",
      to: "bounded_referenceable_context",
      reason: "deterministic_lane_bounds",
      tokensBefore: before,
      tokensAfter: budget.measuredInputTokens,
    });
  }

  return {
    stateView,
    turnInput,
    intermediateBudget,
    finalBudget: budget,
    transformations,
    ...(projection ? { projection } : {}),
    ...(streamProjection ? { streamProjection } : {}),
    mode,
    measured,
  };
}

function rebuildTurnInput(
  turnInput: LlmTurnInput,
  stateView: AgentPromptStateView,
  buildPrompt: (stateView: AgentPromptStateView) => string,
): LlmTurnInput {
  return {
    ...turnInput,
    messages: replaceFirstUserPrompt(turnInput.messages, buildPrompt(stateView)),
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

async function measure(
  input: { provider: LlmProvider; contextLimits: ResolvedModelContextLimits },
  turnInput: LlmTurnInput,
): Promise<ContextBudgetReport> {
  return await measureTurnContext({
    provider: input.provider,
    turnInput,
    limits: input.contextLimits,
  });
}
