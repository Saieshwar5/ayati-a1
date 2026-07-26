import type { LlmProvider } from "../../core/contracts/provider.js";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import {
  buildFullContextCompilationReceipt,
  buildStreamCheckpointCompilationReceipt,
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
import { generateStreamCheckpoint } from "./stream-checkpoint-generator.js";
import { buildCommittedStreamCheckpointTurnInput } from "./stream-checkpoint-projection.js";
import type { ContextPreparationManager } from "../context-preparation/manager.js";
import { compilePreparedMainContext } from "../context-preparation/main-admission.js";
import type { DecisionContextCompilation } from "../context-preparation/admission-types.js";

export type { DecisionContextCompilation } from "../context-preparation/admission-types.js";

export async function compileDecisionContext(input: {
  provider: LlmProvider;
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  contextLimits: ResolvedModelContextLimits;
  decisionAttempt: number;
  policy: ToolContextProjectionPolicy;
  contextCheckpoint?: AgentContextCheckpointCoordinator;
  contextPreparation?: ContextPreparationManager;
  applyAuthoritativeContext?: (context: ContextEngineMachineContext) => AgentStateView;
  allowBackgroundPreparation?: boolean;
  allowSynchronousSemanticRecovery?: boolean;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): Promise<DecisionContextCompilation> {
  if (input.contextPreparation) {
    return await compilePreparedMainContext({
      ...input,
      manager: input.contextPreparation,
      allowBackgroundPreparation: input.allowBackgroundPreparation !== false,
      allowSynchronousSemanticRecovery: input.allowSynchronousSemanticRecovery !== false,
    });
  }
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

  const protectFromSeq = currentInputSequence(input.stateView);
  if (!input.contextCheckpoint || protectFromSeq === undefined) {
    return exhaustedCompilation({
      ...toolCompilation,
      finalBudget: intermediateBudget,
      finalTurnInput: intermediateTurnInput,
      finalBudgetMeasured: true,
    });
  }
  const checkpointPlan = await input.contextCheckpoint.plan({
    protectFromSeq,
    requiredSavingsTokens: Math.max(
      1,
      intermediateBudget.measuredInputTokens - intermediateBudget.recoveryTargetTokens,
    ),
    estimatedCheckpointTokens: 1_200,
  });
  if (!checkpointPlan.triggered) {
    return exhaustedCompilation({
      ...toolCompilation,
      finalBudget: intermediateBudget,
      finalTurnInput: intermediateTurnInput,
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
      ...toolCompilation,
      finalBudget: intermediateBudget,
      finalTurnInput: intermediateTurnInput,
      finalBudgetMeasured: true,
      streamCheckpoint: { plan: checkpointPlan, generation },
    });
  }
  const committed = await input.contextCheckpoint.commit({
    plan: checkpointPlan,
    summary: generation.summary,
    tokenCount: generation.tokenCount,
    provider: input.provider.name,
    model: input.provider.version,
  });
  const checkpoint = committed.checkpoint;
  const finalTurnInput = buildCommittedStreamCheckpointTurnInput({
    stateView: input.stateView,
    turnInput: intermediateTurnInput,
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
    tokensBefore: intermediateBudget.measuredInputTokens,
    tokensAfter: finalBudget.measuredInputTokens,
  };
  return {
    candidateBudget,
    intermediateBudget,
    finalBudget,
    finalTurnInput,
    finalBudgetMeasured: true,
    receipt: buildStreamCheckpointCompilationReceipt({
      candidate: candidateBudget,
      intermediate: intermediateBudget,
      final: finalBudget,
      decisionAttempt: input.decisionAttempt,
      transformations: [...toolTransformations, checkpointTransformation],
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
      recoveryExhausted: finalBudget.softLimitExceeded,
    }),
    ...(projectionResult ? { projection: projectionResult } : {}),
    streamCheckpoint: { plan: checkpointPlan, generation, checkpoint },
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
  return stateView.context.core.current.input.seq > 0
    ? stateView.context.core.current.input.seq
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
