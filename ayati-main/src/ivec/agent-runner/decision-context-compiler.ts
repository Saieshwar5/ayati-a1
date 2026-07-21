import type { LlmProvider } from "../../core/contracts/provider.js";
import type { ContextCheckpointPlan, ContextCheckpointRecord } from "ayati-context-engine";
import type { LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import {
  buildFullContextCompilationReceipt,
  buildStreamCheckpointCompilationReceipt,
  buildStreamProjectionCompilationReceipt,
  buildToolCompactContextCompilationReceipt,
} from "../../prompt/context-compilation-receipt.js";
import type { ContextCompilationReceipt } from "../../prompt/context-compilation-receipt.js";
import { measureTurnContext } from "../../prompt/context-token-counter.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type {
  AgentContextCheckpointCoordinator,
  ToolContextProjectionPolicy,
} from "../types.js";
import type { AgentPromptStateView } from "./prompt-context.js";
import type { AgentStateView } from "./state-view.js";
import { planToolContextProjection } from "./tool-context-projection-planner.js";
import { buildToolContextProjectionCandidate } from "./tool-context-shadow.js";
import type { ToolContextShadowReceipt } from "./tool-context-shadow.js";
import {
  buildStreamContextProjectionCandidate,
  type StreamContextProjectionReceipt,
} from "./stream-context-projection.js";
import { generateStreamCheckpoint } from "./stream-checkpoint-generator.js";
import type { StreamCheckpointGenerationResult } from "./stream-checkpoint-generator.js";
import { buildCommittedStreamCheckpointTurnInput } from "./stream-checkpoint-projection.js";

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
}

export async function compileDecisionContext(input: {
  provider: LlmProvider;
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  contextLimits: ResolvedModelContextLimits;
  decisionAttempt: number;
  policy: ToolContextProjectionPolicy;
  contextCheckpoint?: AgentContextCheckpointCoordinator;
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

  if (!candidateBudget.softLimitExceeded) {
    return fullCompilation(input.turnInput, candidateBudget, input.decisionAttempt);
  }

  let intermediateTurnInput = input.turnInput;
  let intermediateBudget = candidateBudget;
  let projectionResult: DecisionContextCompilation["projection"];
  let toolTransformations: ContextCompilationReceipt["transformations"] = [];
  if (toolPlan.triggered) {
    const toolProjection = buildToolContextProjectionCandidate({
      stateView: input.stateView,
      requestMessages: input.turnInput.messages,
      turnInput: input.turnInput,
      plan: toolPlan,
      budget: candidateBudget,
      buildPrompt: input.buildPrompt,
    });
    toolTransformations = toolPlan.calls
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
    projectionResult = {
      event: input.policy === "enforce"
        ? "tool_context_projection_enforced"
        : "tool_context_projection_shadow",
      policy: input.policy,
      receipt: toolProjection.receipt,
    };
    if (input.policy === "enforce" && toolTransformations.length > 0) {
      intermediateTurnInput = toolProjection.turnInput;
      intermediateBudget = await measureTurnContext({
        provider: input.provider,
        turnInput: intermediateTurnInput,
        limits: input.contextLimits,
      });
    }
  }
  const toolCompilation = projectionResult && input.policy === "enforce"
    ? enforcedToolCompilation({
        turnInput: intermediateTurnInput,
        candidateBudget,
        intermediateBudget,
        decisionAttempt: input.decisionAttempt,
        transformations: toolTransformations,
        projection: projectionResult,
      })
    : {
        ...fullCompilation(input.turnInput, candidateBudget, input.decisionAttempt),
        ...(projectionResult ? { projection: projectionResult } : {}),
      };

  if (!intermediateBudget.softLimitExceeded) {
    return toolCompilation;
  }

  const projectedToolCalls = input.policy === "enforce" && toolTransformations.length > 0
    ? toolPlan.projectedCalls
    : undefined;
  const streamCandidate = buildStreamContextProjectionCandidate({
    stateView: input.stateView,
    turnInput: intermediateTurnInput,
    ...(projectedToolCalls ? { projectedToolCalls } : {}),
    buildPrompt: input.buildPrompt,
  });
  const streamTurnInput = streamCandidate.receipt.triggered
    ? streamCandidate.turnInput
    : intermediateTurnInput;
  const streamBudget = streamCandidate.receipt.triggered
    ? await measureTurnContext({
        provider: input.provider,
        turnInput: streamTurnInput,
        limits: input.contextLimits,
      })
    : intermediateBudget;
  const streamTransformation = streamCandidate.receipt.triggered ? [{
    kind: "stream_context_projection",
    from: "full_stream_projection",
    to: "bounded_stream_projection",
    reason: "soft_limit_after_tool_compaction",
    tokensBefore: intermediateBudget.measuredInputTokens,
    tokensAfter: streamBudget.measuredInputTokens,
  }] : [];
  const streamCompilation = streamCandidate.receipt.triggered
    ? enforcedStreamProjectionCompilation({
        turnInput: streamTurnInput,
        candidateBudget,
        intermediateBudget,
        finalBudget: streamBudget,
        decisionAttempt: input.decisionAttempt,
        transformations: [...toolTransformations, ...streamTransformation],
        ...(projectionResult ? { projection: projectionResult } : {}),
        streamProjection: streamCandidate.receipt,
      })
    : toolCompilation;

  if (!streamBudget.softLimitExceeded) {
    return streamCompilation;
  }

  const protectFromSeq = currentInputSequence(input.stateView);
  if (!input.contextCheckpoint || protectFromSeq === undefined) {
    return exhaustedCompilation({
      ...streamCompilation,
      finalBudget: streamBudget,
      finalTurnInput: streamTurnInput,
      finalBudgetMeasured: true,
    });
  }
  const checkpointPlan = await input.contextCheckpoint.plan({
    protectFromSeq,
    requiredSavingsTokens: Math.max(
      1,
      streamBudget.measuredInputTokens - streamBudget.recoveryTargetTokens,
    ),
    estimatedCheckpointTokens: 1_200,
  });
  if (!checkpointPlan.triggered) {
    return exhaustedCompilation({
      ...streamCompilation,
      finalBudget: streamBudget,
      finalTurnInput: streamTurnInput,
      finalBudgetMeasured: true,
      streamCheckpoint: { plan: checkpointPlan },
    });
  }

  const generation = await generateStreamCheckpoint({
    provider: input.provider,
    plan: checkpointPlan,
    maxInputTokens: input.contextLimits.maxInputTokens
      ?? input.contextLimits.contextWindowTokens - input.contextLimits.outputReserveTokens,
  });
  if (generation.status !== "success" || !generation.summary || generation.tokenCount === undefined) {
    return exhaustedCompilation({
      ...streamCompilation,
      finalBudget: streamBudget,
      finalTurnInput: streamTurnInput,
      finalBudgetMeasured: true,
      streamCheckpoint: { plan: checkpointPlan, generation },
    });
  }
  const checkpoint = await input.contextCheckpoint.commit({
    plan: checkpointPlan,
    summary: generation.summary,
    tokenCount: generation.tokenCount,
    provider: input.provider.name,
    model: input.provider.version,
  });
  const finalTurnInput = buildCommittedStreamCheckpointTurnInput({
    stateView: input.stateView,
    turnInput: streamTurnInput,
    plan: checkpointPlan,
    checkpoint,
    ...(projectedToolCalls ? { projectedToolCalls } : {}),
    buildPrompt: input.buildPrompt,
  });
  const finalBudget = await measureTurnContext({
    provider: input.provider,
    turnInput: finalTurnInput,
    limits: input.contextLimits,
  });
  const checkpointTransformation = {
    kind: "stream_checkpoint",
    from: "exact_events",
    to: "durable_checkpoint_and_exact_tail",
    reason: "unresolved_context_pressure",
    coveredFromSeq: checkpoint.coveredFromSeq,
    coveredToSeq: checkpoint.coveredToSeq,
    sourceHash: checkpoint.sourceHash,
    tokensBefore: streamBudget.measuredInputTokens,
    tokensAfter: finalBudget.measuredInputTokens,
  };
  return {
    candidateBudget,
    intermediateBudget: streamBudget,
    finalBudget,
    finalTurnInput,
    finalBudgetMeasured: true,
    receipt: buildStreamCheckpointCompilationReceipt({
      candidate: candidateBudget,
      intermediate: streamBudget,
      final: finalBudget,
      decisionAttempt: input.decisionAttempt,
      transformations: [...toolTransformations, ...streamTransformation, checkpointTransformation],
      checkpoint: {
        coveredFromSeq: checkpoint.coveredFromSeq,
        coveredToSeq: checkpoint.coveredToSeq,
        sourceEventCount: checkpointPlan.selectedMessages.length
          + (checkpointPlan.previousCheckpoint ? 1 : 0),
        sourceHash: checkpoint.sourceHash,
        checkpointTokens: checkpoint.tokenCount,
        cacheStatus: "generated",
        generationAttempts: generation.attempts.length,
      },
      ...(streamCandidate.receipt.triggered ? {
        streamProjection: toStreamProjectionReceipt(
          streamCandidate.receipt,
          intermediateBudget.measuredInputTokens,
          streamBudget.measuredInputTokens,
        ),
      } : {}),
      recoveryExhausted: finalBudget.softLimitExceeded,
    }),
    ...(projectionResult ? { projection: projectionResult } : {}),
    ...(streamCandidate.receipt.triggered ? { streamProjection: streamCandidate.receipt } : {}),
    streamCheckpoint: { plan: checkpointPlan, generation, checkpoint },
  };
}

function enforcedStreamProjectionCompilation(input: {
  turnInput: LlmTurnInput;
  candidateBudget: ContextBudgetReport;
  intermediateBudget: ContextBudgetReport;
  finalBudget: ContextBudgetReport;
  decisionAttempt: number;
  transformations: ContextCompilationReceipt["transformations"];
  projection?: NonNullable<DecisionContextCompilation["projection"]>;
  streamProjection: StreamContextProjectionReceipt;
}): DecisionContextCompilation {
  return {
    candidateBudget: input.candidateBudget,
    intermediateBudget: input.intermediateBudget,
    finalBudget: input.finalBudget,
    finalTurnInput: input.turnInput,
    finalBudgetMeasured: true,
    receipt: buildStreamProjectionCompilationReceipt({
      candidate: input.candidateBudget,
      intermediate: input.intermediateBudget,
      final: input.finalBudget,
      decisionAttempt: input.decisionAttempt,
      transformations: input.transformations,
      projection: toStreamProjectionReceipt(
        input.streamProjection,
        input.intermediateBudget.measuredInputTokens,
        input.finalBudget.measuredInputTokens,
      ),
    }),
    ...(input.projection ? { projection: input.projection } : {}),
    streamProjection: input.streamProjection,
  };
}

function toStreamProjectionReceipt(
  projection: StreamContextProjectionReceipt,
  tokensBefore: number,
  tokensAfter: number,
): NonNullable<ContextCompilationReceipt["streamProjection"]> {
  return {
    removedCandidateCount: projection.removedCandidateCount,
    removedRecentWorkCount: projection.removedRecentWorkCount,
    removedResourceCount: projection.removedResourceCount,
    removedObservationCount: projection.removedObservationCount,
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

function currentInputSequence(stateView: AgentStateView): number | undefined {
  return stateView.context.current.inputSeq > 0
    ? stateView.context.current.inputSeq
    : undefined;
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
