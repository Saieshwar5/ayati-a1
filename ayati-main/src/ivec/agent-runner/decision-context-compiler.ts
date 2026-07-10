import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import {
  buildFullContextCompilationReceipt,
  buildTimelineCheckpointCompilationReceipt,
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
import { createTimelineCheckpointCache } from "./timeline-checkpoint-cache.js";
import type { TimelineCheckpointCacheState } from "./timeline-checkpoint-cache.js";
import { generateTimelineCheckpoint } from "./timeline-checkpoint-generator.js";
import type { TimelineCheckpointGenerationResult } from "./timeline-checkpoint-generator.js";
import { buildTimelineCheckpointTurnInput } from "./timeline-checkpoint-projection.js";
import { planTimelineCheckpoint } from "./timeline-checkpoint.js";
import type {
  ExactTimelineEvent,
  TimelineCheckpointPlan,
} from "./timeline-checkpoint.js";

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
  timelineCheckpoint?: {
    plan: TimelineCheckpointPlan;
    generation?: TimelineCheckpointGenerationResult;
  };
}

export async function compileDecisionContext(input: {
  provider: LlmProvider;
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  contextLimits: ResolvedModelContextLimits;
  decisionAttempt: number;
  policy: ToolContextProjectionPolicy;
  timelineCheckpointCache?: TimelineCheckpointCacheState;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): Promise<DecisionContextCompilation> {
  const candidateBudget = await measureTurnContext({
    provider: input.provider,
    turnInput: input.turnInput,
    limits: input.contextLimits,
  });
  const toolPlan = planToolContextProjection({
    calls: input.stateView.context.run?.toolCalls ?? [],
    candidateInputTokens: candidateBudget.measuredInputTokens,
    recoveryTargetTokens: candidateBudget.recoveryTargetTokens,
    softInputTokens: candidateBudget.softInputTokens,
  });

  if (!toolPlan.triggered) {
    return fullCompilation(input.turnInput, candidateBudget, input.decisionAttempt);
  }

  const toolProjection = buildToolContextProjectionCandidate({
    stateView: input.stateView,
    requestMessages: input.turnInput.messages,
    turnInput: input.turnInput,
    plan: toolPlan,
    budget: candidateBudget,
    buildPrompt: input.buildPrompt,
  });
  const projectionEvent: "tool_context_projection_shadow" | "tool_context_projection_enforced" =
    input.policy === "enforce"
      ? "tool_context_projection_enforced"
      : "tool_context_projection_shadow";
  const toolTransformations = toolPlan.calls
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
    receipt: toolProjection.receipt,
  };

  if (input.policy !== "enforce") {
    const compilation = fullCompilation(input.turnInput, candidateBudget, input.decisionAttempt);
    return {
      ...compilation,
      receipt: {
        ...compilation.receipt,
        toolProjectionPolicy: input.policy,
      },
      projection: projectionResult,
    };
  }

  const intermediateTurnInput = toolTransformations.length > 0
    ? toolProjection.turnInput
    : input.turnInput;
  const intermediateBudget = toolTransformations.length > 0
    ? await measureTurnContext({
        provider: input.provider,
        turnInput: intermediateTurnInput,
        limits: input.contextLimits,
      })
    : candidateBudget;
  const toolCompilation = enforcedToolCompilation({
    turnInput: intermediateTurnInput,
    candidateBudget,
    intermediateBudget,
    decisionAttempt: input.decisionAttempt,
    transformations: toolTransformations,
    projection: projectionResult,
  });

  if (!shouldApplyTimelineCheckpoint(input.stateView, intermediateBudget)) {
    return toolCompilation;
  }

  const timelinePlan = planTimelineCheckpoint({
    events: exactTimelineEvents(input.stateView),
    requiredSavingsTokens: intermediateBudget.measuredInputTokens
      - intermediateBudget.recoveryTargetTokens,
  });
  if (!timelinePlan.triggered) {
    return { ...toolCompilation, timelineCheckpoint: { plan: timelinePlan } };
  }

  const generation = await generateTimelineCheckpoint({
    provider: input.provider,
    plan: timelinePlan,
    cache: input.timelineCheckpointCache ?? createTimelineCheckpointCache(),
    maxInputTokens: input.contextLimits.maxInputTokens
      ?? input.contextLimits.contextWindowTokens - input.contextLimits.outputReserveTokens,
  });
  if (generation.status !== "success" || !generation.checkpoint || generation.checkpointTokens === undefined) {
    return {
      ...toolCompilation,
      timelineCheckpoint: { plan: timelinePlan, generation },
    };
  }

  const finalTurnInput = buildTimelineCheckpointTurnInput({
    stateView: input.stateView,
    turnInput: input.turnInput,
    plan: timelinePlan,
    checkpoint: generation.checkpoint,
    ...(toolTransformations.length > 0 ? { projectedToolCalls: toolPlan.projectedCalls } : {}),
    buildPrompt: input.buildPrompt,
  });
  const finalBudget = await measureTurnContext({
    provider: input.provider,
    turnInput: finalTurnInput,
    limits: input.contextLimits,
  });
  const timelineTransformation = {
    kind: "timeline_checkpoint",
    from: "exact_events",
    to: "checkpoint",
    reason: "unresolved_context_pressure",
    coveredFromSeq: generation.checkpoint.coveredFromSeq,
    coveredToSeq: generation.checkpoint.coveredToSeq,
    sourceHash: generation.checkpoint.sourceHash,
    tokensBefore: timelinePlan.selectedEventTokens,
    tokensAfter: generation.checkpointTokens,
  };
  return {
    candidateBudget,
    intermediateBudget,
    finalBudget,
    finalTurnInput,
    finalBudgetMeasured: true,
    receipt: buildTimelineCheckpointCompilationReceipt({
      candidate: candidateBudget,
      intermediate: intermediateBudget,
      final: finalBudget,
      decisionAttempt: input.decisionAttempt,
      transformations: [...toolTransformations, timelineTransformation],
      checkpoint: {
        coveredFromSeq: generation.checkpoint.coveredFromSeq,
        coveredToSeq: generation.checkpoint.coveredToSeq,
        sourceEventCount: generation.checkpoint.sourceEventCount,
        sourceHash: generation.checkpoint.sourceHash,
        checkpointTokens: generation.checkpointTokens,
        cacheStatus: generation.cacheStatus === "success_hit" ? "success_hit" : "generated",
        generationAttempts: generation.attempts.length,
      },
    }),
    projection: projectionResult,
    timelineCheckpoint: { plan: timelinePlan, generation },
  };
}

function enforcedToolCompilation(input: {
  turnInput: LlmTurnInput;
  candidateBudget: ContextBudgetReport;
  intermediateBudget: ContextBudgetReport;
  decisionAttempt: number;
  transformations: ContextCompilationReceipt["transformations"];
  projection: NonNullable<DecisionContextCompilation["projection"]>;
}): DecisionContextCompilation {
  if (input.transformations.length > 0) {
    return {
      candidateBudget: input.candidateBudget,
      intermediateBudget: input.intermediateBudget,
      finalBudget: input.intermediateBudget,
      finalTurnInput: input.turnInput,
      finalBudgetMeasured: true,
      receipt: buildToolCompactContextCompilationReceipt({
        candidate: input.candidateBudget,
        final: input.intermediateBudget,
        decisionAttempt: input.decisionAttempt,
        transformations: input.transformations,
      }),
      projection: input.projection,
    };
  }

  const compilation = fullCompilation(input.turnInput, input.candidateBudget, input.decisionAttempt);
  return {
    ...compilation,
    receipt: {
      ...compilation.receipt,
      toolProjectionPolicy: "enforce",
      targetReached: input.candidateBudget.measuredInputTokens <= input.candidateBudget.recoveryTargetTokens,
      needsEscalation: input.candidateBudget.measuredInputTokens > input.candidateBudget.recoveryTargetTokens,
    },
    projection: input.projection,
  };
}

function shouldApplyTimelineCheckpoint(
  stateView: AgentStateView,
  budget: ContextBudgetReport,
): boolean {
  return stateView.context.run?.contextPressure?.recommendedMode === "timeline_checkpoint"
    && budget.measuredInputTokens > budget.recoveryTargetTokens;
}

function exactTimelineEvents(stateView: AgentStateView): ExactTimelineEvent[] {
  return stateView.context.timeline.filter(
    (event): event is ExactTimelineEvent => event.kind !== "checkpoint",
  );
}

function fullCompilation(
  turnInput: LlmTurnInput,
  budget: ContextBudgetReport,
  decisionAttempt: number,
): DecisionContextCompilation {
  return {
    candidateBudget: budget,
    intermediateBudget: budget,
    finalBudget: budget,
    finalTurnInput: turnInput,
    finalBudgetMeasured: false,
    receipt: buildFullContextCompilationReceipt(budget, decisionAttempt),
  };
}
