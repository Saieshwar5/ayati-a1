import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import {
  buildFullContextCompilationReceipt,
  enrichContextCompilationReceipt,
  type ContextCompilationReceipt,
  type ContextCompilationMode,
} from "../../prompt/context-compilation-receipt.js";
import { measureTurnContext } from "../../prompt/context-token-counter.js";
import { estimateTextTokens, estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import {
  buildWorkstreamResolutionTurnInput,
  type ResolutionDecisionContext,
} from "../workstream-resolution/decision.js";
import { createResolverPreparationJob, resolverOverlayFromCandidate, validateResolverCandidate } from "./resolver-candidates.js";
import {
  applyResolverFocusOverlay,
  projectResolverContext,
  type ResolverFocusOverlay,
} from "./resolver-context.js";
import type { ContextPreparationManager } from "./manager.js";
import {
  decideContextPreparationTrigger,
  forcedSynchronousBarrier,
  modelProfileVersion,
  preparationLeadTokens,
} from "./policy.js";
import type {
  ContextLane,
  ContextPreparationBackgroundUsage,
  ContextPreparationCandidate,
  ContextPreparationEvent,
  PromptContextManifest,
  PromptContextPart,
} from "./types.js";
import { CONTEXT_PREPARATION_POLICY_VERSION } from "./types.js";

export interface ResolverContextCompilation {
  context: ResolutionDecisionContext;
  persistedContext: ResolutionDecisionContext;
  turnInput: LlmTurnInput;
  candidateBudget: ContextBudgetReport;
  finalBudget: ContextBudgetReport;
  receipt: ContextCompilationReceipt;
  backgroundUsage?: ContextPreparationBackgroundUsage;
  events: ContextPreparationEvent[];
}

export class ResolverContextLimitError extends Error {
  constructor(
    readonly receipt: ContextCompilationReceipt,
    readonly persistedContext: ResolutionDecisionContext,
    readonly backgroundUsage?: ContextPreparationBackgroundUsage,
  ) {
    super(
      `Resolver input remains at ${receipt.finalInputTokens} tokens, outside its ${receipt.forcedBarrierTokens}-token safe barrier.`,
    );
    this.name = "ResolverContextLimitError";
  }
}

export async function compileResolverContext(input: {
  provider: LlmProvider;
  context: ResolutionDecisionContext;
  limits: ResolvedModelContextLimits;
  manager: ContextPreparationManager;
  allowBackgroundPreparation: boolean;
  allowSynchronousSemanticRecovery: boolean;
}): Promise<ResolverContextCompilation> {
  const profileVersion = modelProfileVersion(input.limits);
  const leadTokens = preparationLeadTokens(input.limits.contextWindowTokens);
  let activeOverlay = input.manager.activeOverlay<ResolverFocusOverlay>();
  const sourceContext = applyResolverFocusOverlay(input.context, activeOverlay);
  let workingContext = sourceContext;
  let turnInput = buildWorkstreamResolutionTurnInput(workingContext);
  const candidateManifest = buildResolverManifest(workingContext, turnInput);
  input.manager.recordManifest(candidateManifest, input.limits.hardInputTokens);
  const candidateBudget = await measure(input, turnInput);
  let finalBudget = candidateBudget;
  let mode: ContextCompilationMode = activeOverlay ? "step_ledger" : "full";
  let transformations: ContextCompilationReceipt["transformations"] = [];
  let candidateAction: ContextCompilationReceipt["candidateAction"] = "none";
  let candidateReason: string | undefined;
  let adoptedCandidate: ContextPreparationCandidate | undefined;
  let forcedRecovery = atForcedBarrier(finalBudget);

  const adopt = async (candidate: ContextPreparationCandidate, waited = false): Promise<boolean> => {
    const validation = validateResolverCandidate({
      candidate,
      laneId: input.manager.laneId,
      context: sourceContext,
      modelProfileVersion: profileVersion,
      activeOverlay,
    });
    if (!validation.valid) {
      input.manager.markStale(candidate.candidateId, validation.reason);
      candidateAction = "rejected";
      candidateReason = validation.reason;
      return false;
    }
    const overlay = resolverOverlayFromCandidate(candidate);
    if (!overlay) {
      input.manager.markStale(candidate.candidateId, "resolver_focus_overlay_missing");
      candidateAction = "rejected";
      candidateReason = "resolver_focus_overlay_missing";
      return false;
    }
    const before = finalBudget.measuredInputTokens;
    input.manager.markValidated(candidate.candidateId, validation.reason);
    activeOverlay = overlay;
    input.manager.setOverlay(overlay);
    workingContext = applyResolverFocusOverlay(input.context, overlay);
    turnInput = buildWorkstreamResolutionTurnInput(workingContext);
    finalBudget = await measure(input, turnInput);
    transformations.push({
      kind: "resolver_focus_candidate",
      from: "older_resolver_projection",
      to: "anchored_resolver_focus_and_exact_tail",
      reason: waited ? "forced_barrier_wait" : "ready_candidate",
      tokensBefore: before,
      tokensAfter: finalBudget.measuredInputTokens,
    });
    input.manager.markAdopted(
      candidate.candidateId,
      waited ? "awaited_and_adopted" : "validated_and_adopted",
      { tokensBefore: before, tokensAfter: finalBudget.measuredInputTokens },
    );
    adoptedCandidate = input.manager.currentCandidate() ?? { ...candidate, status: "adopted" };
    candidateAction = "adopted";
    candidateReason = validation.reason;
    mode = "step_ledger";
    return true;
  };

  const ready = input.manager.readyCandidate();
  if (ready) await adopt(ready);
  if (atForcedBarrier(finalBudget)) {
    forcedRecovery = true;
    const preparing = input.manager.currentCandidate();
    if (preparing?.status === "preparing") {
      const awaited = await input.manager.awaitRelevant(preparing.jobKey);
      if (awaited) await adopt(awaited, true);
    }
  }

  if (finalBudget.softLimitExceeded) {
    const before = finalBudget.measuredInputTokens;
    const projected = projectResolverContext(workingContext);
    workingContext = projected.context;
    turnInput = buildWorkstreamResolutionTurnInput(workingContext);
    finalBudget = await measure(input, turnInput);
    if (projected.receipt.removedSuccessfulStepCount > 0) {
      mode = mode === "step_ledger" ? mode : "stream_project";
      transformations.push({
        kind: "resolver_success_output_projection",
        from: "complete_private_success_history",
        to: "typed_ids_heads_descriptions_and_exact_hot_tail",
        reason: `olderSuccessfulSteps=${projected.receipt.removedSuccessfulStepCount}`,
        tokensBefore: before,
        tokensAfter: finalBudget.measuredInputTokens,
      });
    }
  }

  if (
    atForcedBarrier(finalBudget)
    && input.allowSynchronousSemanticRecovery
  ) {
    forcedRecovery = true;
    const job = createResolverPreparationJob({
      provider: input.provider,
      laneId: input.manager.laneId,
      context: sourceContext,
      currentInputTokens: finalBudget.measuredInputTokens,
      recoveryTargetTokens: finalBudget.recoveryTargetTokens,
      maxInputTokens: input.limits.hardInputTokens,
      modelProfileVersion: profileVersion,
      activeOverlay,
      synchronous: true,
    });
    if (job) {
      const candidate = await input.manager.prepareSynchronously(job);
      if (candidate && await adopt(candidate, true) && finalBudget.softLimitExceeded) {
        const before = finalBudget.measuredInputTokens;
        const projected = projectResolverContext(workingContext);
        workingContext = projected.context;
        turnInput = buildWorkstreamResolutionTurnInput(workingContext);
        finalBudget = await measure(input, turnInput);
        if (projected.receipt.removedSuccessfulStepCount > 0) {
          transformations.push({
            kind: "resolver_success_output_projection",
            from: "focus_overlay_with_private_history",
            to: "focus_overlay_with_exact_hot_tail",
            reason: "post_focus_deterministic_projection",
            tokensBefore: before,
            tokensAfter: finalBudget.measuredInputTokens,
          });
        }
      }
    }
  }

  const trigger = decideContextPreparationTrigger({
    measuredInputTokens: finalBudget.measuredInputTokens,
    preparationInputTokens: finalBudget.preparationInputTokens,
    softInputTokens: finalBudget.softInputTokens,
    preparationLeadTokens: leadTokens,
  });
  let backgroundStarted = false;
  let backgroundDeduplicated = false;
  if (input.allowBackgroundPreparation && trigger.triggered) {
    const job = createResolverPreparationJob({
      provider: input.provider,
      laneId: input.manager.laneId,
      context: sourceContext,
      currentInputTokens: finalBudget.measuredInputTokens,
      recoveryTargetTokens: finalBudget.recoveryTargetTokens,
      maxInputTokens: input.limits.hardInputTokens,
      modelProfileVersion: profileVersion,
      activeOverlay,
      synchronous: false,
    });
    if (job) {
      const started = input.manager.startBackground(job);
      backgroundStarted = started.status === "started";
      backgroundDeduplicated = started.status === "deduplicated";
    } else {
      input.manager.recordSkip("resolver_no_eligible_prefix", { triggerReason: trigger.reason });
    }
  } else if (input.allowBackgroundPreparation) {
    input.manager.recordSkip(trigger.reason, { predictedInputTokens: trigger.predictedInputTokens });
  }

  const finalManifest = buildResolverManifest(workingContext, turnInput);
  if (finalManifest.totalLocalEstimate !== candidateManifest.totalLocalEstimate) {
    input.manager.recordManifest(finalManifest, input.limits.hardInputTokens);
  }
  const barrier = forcedSynchronousBarrier(finalBudget);
  const recoveryExhausted = forcedRecovery && finalBudget.measuredInputTokens >= barrier;
  const candidate = adoptedCandidate ?? input.manager.currentCandidate();
  const base = buildFullContextCompilationReceipt(finalBudget, workingContext.history.length + 1);
  const receipt = enrichContextCompilationReceipt({
    ...base,
    mode,
    candidateInputTokens: candidateBudget.measuredInputTokens,
    finalInputTokens: finalBudget.measuredInputTokens,
    softLimitExceeded: candidateBudget.softLimitExceeded,
    candidateHardLimitExceeded: candidateBudget.hardLimitExceeded,
    candidateCountSource: candidateBudget.countSource,
    admitted: !finalBudget.admissionLimitExceeded,
    toolProjectionPolicy: "enforce",
    targetReached: finalBudget.measuredInputTokens <= finalBudget.recoveryTargetTokens,
    needsEscalation: finalBudget.softLimitExceeded && !recoveryExhausted,
    ...(recoveryExhausted ? { recoveryExhausted: true } : {}),
    transformations,
  }, {
    preparationLeadTokens: leadTokens,
    manifestPolicyVersion: finalManifest.policyVersion,
    laneEstimates: finalManifest.laneEstimates,
    candidateLaneEstimates: candidateManifest.laneEstimates,
    toolSchemaTokens: finalManifest.toolSchemaTokens,
    forcedRecovery,
    ...(candidate ? {
      candidate: {
        candidateId: candidate.candidateId,
        laneId: candidate.laneId,
        kind: candidate.kind,
        status: candidate.status,
        targetReached: candidate.targetReached,
      },
    } : {}),
    candidateAction,
    ...(candidateReason
      ? { candidateReason }
      : candidate?.failureReason
        ? { candidateReason: candidate.failureReason }
        : candidate?.lifecycleReason
          ? { candidateReason: candidate.lifecycleReason }
          : {}),
    backgroundPreparation: {
      triggered: backgroundStarted || input.manager.currentCandidate()?.status === "preparing",
      deduplicated: backgroundDeduplicated,
      overlappedForeground: backgroundStarted || backgroundDeduplicated,
      ...(candidate?.background ? {
        durationMs: candidate.background.durationMs,
        attempts: candidate.background.attempts,
        inputTokens: candidate.background.usage?.inputTokens,
        outputTokens: candidate.background.usage?.outputTokens,
        cachedInputTokens: candidate.background.usage?.cachedInputTokens,
        costUsd: candidate.background.cost?.totalCostUsd,
      } : {}),
    },
  });
  const persistedContext: ResolutionDecisionContext = {
    ...workingContext,
    contextPreparation: receipt,
  };
  const backgroundUsage = input.manager.consumeBackgroundUsage();
  if (finalBudget.admissionLimitExceeded || recoveryExhausted) {
    input.manager.recordLimitTermination({
      finalInputTokens: finalBudget.measuredInputTokens,
      admissionLimitTokens: finalBudget.admissionLimitTokens,
      forcedBarrierTokens: barrier,
    });
    throw new ResolverContextLimitError(receipt, persistedContext, backgroundUsage);
  }
  return {
    context: workingContext,
    persistedContext,
    turnInput,
    candidateBudget,
    finalBudget,
    receipt,
    ...(backgroundUsage ? { backgroundUsage } : {}),
    events: input.manager.drainEvents(),
  };
}

function buildResolverManifest(
  context: ResolutionDecisionContext,
  turnInput: LlmTurnInput,
): PromptContextManifest {
  const parts: PromptContextPart[] = [];
  const add = (
    id: string,
    lane: ContextLane,
    retention: PromptContextPart["retention"],
    content: unknown,
    sourceRefs: string[],
  ) => parts.push({
    id,
    lane,
    retention,
    content,
    sourceRefs,
    localEstimatedTokens: estimateTextTokens(JSON.stringify(content)),
  });
  add("system.resolver_rules", "system", "exact", turnInput.messages.filter((message) => message.role === "system"), []);
  add("system.resolver_tools", "system", "exact", turnInput.tools ?? [], []);
  add("session.previous_conversation", "session", "summarizable", context.previousConversation, []);
  add("session.projected_history", "session", "referenceable", context.projectedHistory ?? {}, context.projectedHistory?.evidenceRefs ?? []);
  if (context.focus) add("session.resolver_focus", "session", "summarizable", context.focus, context.focus.references);
  add("work.identity", "work", "exact", {
    activityId: context.activityId,
    purpose: context.state.purpose,
    currentInput: context.currentInput,
    hints: context.hints,
  }, [`activity:${context.activityId}`]);
  add("work.resources", "work", "exact", context.ingressResources, []);
  add("work.candidates", "work", "hot", context.initialCandidates, []);
  add("work.state", "work", "exact", context.state, []);
  add("work.history", "work", "hot", context.history, context.history.map((step) => `resolver-step:${step.step}`));
  add("work.remaining", "work", "exact", context.remaining, []);
  const estimate = estimateTurnInputTokens(turnInput);
  const laneEstimates: Record<ContextLane, number> = { system: 0, session: 0, work: 0 };
  for (const part of parts) laneEstimates[part.lane] += part.localEstimatedTokens;
  return {
    policyVersion: CONTEXT_PREPARATION_POLICY_VERSION,
    parts,
    laneEstimates,
    toolSchemaTokens: estimate.toolSchemaTokens,
    totalLocalEstimate: estimate.totalTokens,
  };
}

function atForcedBarrier(report: ContextBudgetReport): boolean {
  return report.measuredInputTokens >= forcedSynchronousBarrier(report);
}

async function measure(
  input: { provider: LlmProvider; limits: ResolvedModelContextLimits },
  turnInput: LlmTurnInput,
): Promise<ContextBudgetReport> {
  return await measureTurnContext({ provider: input.provider, limits: input.limits, turnInput });
}
