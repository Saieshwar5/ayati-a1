import type { LlmProvider } from "../../core/contracts/provider.js";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import {
  buildFullContextCompilationReceipt,
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
import type { ContextPreparationManager } from "../context-preparation/manager.js";
import { compilePreparedMainContext } from "../context-preparation/main-admission.js";
import type { DecisionContextCompilation } from "../context-preparation/admission-types.js";
import type { ContextMaintenanceLifecycle } from "../context-preparation/context-maintenance.js";

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
  contextMaintenance?: ContextMaintenanceLifecycle;
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

  return exhaustedCompilation({
    ...toolCompilation,
    finalBudget: intermediateBudget,
    finalTurnInput: intermediateTurnInput,
    finalBudgetMeasured: true,
  });
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
