import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import {
  buildFullContextCompilationReceipt,
  buildSessionSheddingCompilationReceipt,
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
import {
  buildSessionContextSheddingCandidate,
  type SessionContextSheddingReceipt,
} from "./session-context-shedding.js";
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
  sessionShedding?: SessionContextSheddingReceipt;
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

  if (!intermediateBudget.softLimitExceeded) {
    return toolCompilation;
  }

  const sessionCandidate = buildSessionContextSheddingCandidate({
    stateView: input.stateView,
    turnInput: input.turnInput,
    ...(toolTransformations.length > 0 ? { projectedToolCalls: toolPlan.projectedCalls } : {}),
    buildPrompt: input.buildPrompt,
  });
  const sessionTurnInput = sessionCandidate.receipt.triggered
    ? sessionCandidate.turnInput
    : intermediateTurnInput;
  const sessionBudget = sessionCandidate.receipt.triggered
    ? await measureTurnContext({
        provider: input.provider,
        turnInput: sessionTurnInput,
        limits: input.contextLimits,
      })
    : intermediateBudget;
  const sessionTransformation = sessionCandidate.receipt.triggered ? [{
    kind: "session_context_shedding",
    from: "summary_and_recent_checkpoints",
    to: "latest_checkpoint_only",
    reason: "soft_limit_after_tool_compaction",
    tokensBefore: intermediateBudget.measuredInputTokens,
    tokensAfter: sessionBudget.measuredInputTokens,
  }] : [];
  const sessionCompilation = sessionCandidate.receipt.triggered
    ? enforcedSessionSheddingCompilation({
        turnInput: sessionTurnInput,
        candidateBudget,
        intermediateBudget,
        finalBudget: sessionBudget,
        decisionAttempt: input.decisionAttempt,
        transformations: [...toolTransformations, ...sessionTransformation],
        projection: projectionResult,
        shedding: sessionCandidate.receipt,
      })
    : toolCompilation;

  if (!sessionBudget.softLimitExceeded) {
    return sessionCompilation;
  }

  const timelinePlan = planTimelineCheckpoint({
    events: exactTimelineEvents(input.stateView),
    continuityCheckpoint: input.stateView.context.git?.session.recentTaskRuns?.at(-1),
    requiredSavingsTokens: sessionBudget.measuredInputTokens
      - sessionBudget.recoveryTargetTokens,
  });
  if (!timelinePlan.triggered) {
    return exhaustedCompilation({
      ...sessionCompilation,
      finalBudget: sessionBudget,
      finalTurnInput: sessionTurnInput,
      finalBudgetMeasured: true,
      timelineCheckpoint: { plan: timelinePlan },
    });
  }

  const generation = await generateTimelineCheckpoint({
    provider: input.provider,
    plan: timelinePlan,
    cache: input.timelineCheckpointCache ?? createTimelineCheckpointCache(),
    maxInputTokens: input.contextLimits.maxInputTokens
      ?? input.contextLimits.contextWindowTokens - input.contextLimits.outputReserveTokens,
  });
  if (generation.status !== "success" || !generation.checkpoint || generation.checkpointTokens === undefined) {
    return exhaustedCompilation({
      ...sessionCompilation,
      finalBudget: sessionBudget,
      finalTurnInput: sessionTurnInput,
      finalBudgetMeasured: true,
      timelineCheckpoint: { plan: timelinePlan, generation },
    });
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
    tokensBefore: timelinePlan.selectedSourceTokens,
    tokensAfter: generation.checkpointTokens,
  };
  return {
    candidateBudget,
    intermediateBudget: sessionBudget,
    finalBudget,
    finalTurnInput,
    finalBudgetMeasured: true,
    receipt: buildTimelineCheckpointCompilationReceipt({
      candidate: candidateBudget,
      intermediate: sessionBudget,
      final: finalBudget,
      decisionAttempt: input.decisionAttempt,
      transformations: [...toolTransformations, ...sessionTransformation, timelineTransformation],
      checkpoint: {
        coveredFromSeq: generation.checkpoint.coveredFromSeq,
        coveredToSeq: generation.checkpoint.coveredToSeq,
        sourceEventCount: generation.checkpoint.sourceEventCount,
        sourceHash: generation.checkpoint.sourceHash,
        checkpointTokens: generation.checkpointTokens,
        cacheStatus: generation.cacheStatus === "success_hit" ? "success_hit" : "generated",
        generationAttempts: generation.attempts.length,
      },
      ...(sessionCandidate.receipt.triggered ? {
        sessionShedding: toSessionSheddingReceipt(
          sessionCandidate.receipt,
          intermediateBudget.measuredInputTokens,
          sessionBudget.measuredInputTokens,
        ),
      } : {}),
      recoveryExhausted: finalBudget.softLimitExceeded,
    }),
    projection: projectionResult,
    ...(sessionCandidate.receipt.triggered ? { sessionShedding: sessionCandidate.receipt } : {}),
    timelineCheckpoint: { plan: timelinePlan, generation },
  };
}

function enforcedSessionSheddingCompilation(input: {
  turnInput: LlmTurnInput;
  candidateBudget: ContextBudgetReport;
  intermediateBudget: ContextBudgetReport;
  finalBudget: ContextBudgetReport;
  decisionAttempt: number;
  transformations: ContextCompilationReceipt["transformations"];
  projection: NonNullable<DecisionContextCompilation["projection"]>;
  shedding: SessionContextSheddingReceipt;
}): DecisionContextCompilation {
  return {
    candidateBudget: input.candidateBudget,
    intermediateBudget: input.intermediateBudget,
    finalBudget: input.finalBudget,
    finalTurnInput: input.turnInput,
    finalBudgetMeasured: true,
    receipt: buildSessionSheddingCompilationReceipt({
      candidate: input.candidateBudget,
      intermediate: input.intermediateBudget,
      final: input.finalBudget,
      decisionAttempt: input.decisionAttempt,
      transformations: input.transformations,
      shedding: toSessionSheddingReceipt(
        input.shedding,
        input.intermediateBudget.measuredInputTokens,
        input.finalBudget.measuredInputTokens,
      ),
    }),
    projection: input.projection,
    sessionShedding: input.shedding,
  };
}

function toSessionSheddingReceipt(
  shedding: SessionContextSheddingReceipt,
  tokensBefore: number,
  tokensAfter: number,
): NonNullable<ContextCompilationReceipt["sessionShedding"]> {
  return {
    removedSummary: shedding.removedSummary,
    removedCheckpointCount: shedding.removedCheckpointCount,
    ...(shedding.retainedCheckpointId ? { retainedCheckpointId: shedding.retainedCheckpointId } : {}),
    removedActivityCount: shedding.removedActivityCount,
    tokensBefore,
    tokensAfter,
  };
}

function exhaustedCompilation(
  compilation: DecisionContextCompilation,
): DecisionContextCompilation {
  return {
    ...compilation,
    receipt: {
      ...compilation.receipt,
      finalInputTokens: compilation.finalBudget.measuredInputTokens,
      hardLimitExceeded: compilation.finalBudget.hardLimitExceeded,
      admitted: !compilation.finalBudget.admissionLimitExceeded,
      targetReached: false,
      needsEscalation: false,
      recoveryExhausted: true,
    },
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
      needsEscalation: input.candidateBudget.softLimitExceeded,
    },
    projection: input.projection,
  };
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
