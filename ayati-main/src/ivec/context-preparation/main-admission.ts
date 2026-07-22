import type { ContextCheckpointRecord } from "ayati-context-engine";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmMessage, LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import {
  buildFullContextCompilationReceipt,
  enrichContextCompilationReceipt,
  type ContextCompilationReceipt,
  type ContextCompilationMode,
} from "../../prompt/context-compilation-receipt.js";
import { measureTurnContext } from "../../prompt/context-token-counter.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type { AgentStateView } from "../agent-runner/state-view.js";
import { projectAgentStateViewForPrompt, type AgentPromptStateView } from "../agent-runner/prompt-context.js";
import type { StreamContextProjectionReceipt } from "../agent-runner/stream-context-projection.js";
import type {
  AgentContextCheckpointCoordinator,
  ToolContextProjectionPolicy,
} from "../types.js";
import type { DecisionContextCompilation } from "./admission-types.js";
import {
  applyMainFocusOverlay,
  createMainPreparationJob,
  overlayFromCandidate,
  validateMainCandidate,
  type MainFocusOverlay,
} from "./main-candidates.js";
import { previewDurableCheckpointCandidate } from "./main-checkpoint-candidate.js";
import { recoverMainContextDeterministically } from "./main-deterministic-recovery.js";
import type { ContextPreparationManager } from "./manager.js";
import {
  decideContextPreparationTrigger,
  forcedSynchronousBarrier,
  modelProfileVersion,
  preparationLeadTokens,
} from "./policy.js";
import { buildPromptContextManifest } from "./prompt-manifest.js";
import type { ContextPreparationCandidate } from "./types.js";

export interface PreparedMainAdmissionInput {
  provider: LlmProvider;
  stateView: AgentStateView;
  turnInput: LlmTurnInput;
  contextLimits: ResolvedModelContextLimits;
  decisionAttempt: number;
  policy: ToolContextProjectionPolicy;
  manager: ContextPreparationManager;
  contextCheckpoint?: AgentContextCheckpointCoordinator;
  buildPrompt: (stateView: AgentPromptStateView) => string;
  applyAuthoritativeContext?: (context: ContextEngineMachineContext) => AgentStateView;
  allowBackgroundPreparation: boolean;
  allowSynchronousSemanticRecovery: boolean;
}

interface CandidateOutcome {
  candidate?: ContextPreparationCandidate;
  action: ContextCompilationReceipt["candidateAction"];
  reason?: string;
}

export async function compilePreparedMainContext(
  input: PreparedMainAdmissionInput,
): Promise<DecisionContextCompilation> {
  const manager = input.manager;
  const profileVersion = modelProfileVersion(input.contextLimits);
  const leadTokens = preparationLeadTokens(input.contextLimits.contextWindowTokens);
  let activeOverlay = manager.activeOverlay<MainFocusOverlay>();
  let workingState = applyMainFocusOverlay(projectAgentStateViewForPrompt(input.stateView), activeOverlay);
  let workingTurnInput = rebuildTurnInput(input.turnInput, workingState, input.buildPrompt);
  const candidateManifest = buildPromptContextManifest({ stateView: workingState, turnInput: workingTurnInput });
  manager.recordManifest(candidateManifest, input.contextLimits.hardInputTokens);
  const candidateBudget = await measure(input, workingTurnInput);
  let currentBudget = candidateBudget;
  let intermediateBudget = candidateBudget;
  let finalBudgetMeasured = activeOverlay !== undefined;
  let mode: ContextCompilationMode = activeOverlay ? "step_ledger" : "full";
  let forcedRecovery = atForcedBarrier(candidateBudget);
  let candidateOutcome: CandidateOutcome = { action: "none" };
  let projection: DecisionContextCompilation["projection"];
  let streamProjection: StreamContextProjectionReceipt | undefined;
  let adoptedCheckpoint: ContextCheckpointRecord | undefined;
  let adoptedCheckpointCandidate: ContextPreparationCandidate | undefined;
  let transformations: ContextCompilationReceipt["transformations"] = [];

  const considerCandidate = async (
    candidate: ContextPreparationCandidate,
    waited = false,
  ): Promise<boolean> => {
    const validation = validateMainCandidate({
      candidate,
      laneId: manager.laneId,
      stateView: workingState,
      modelProfileVersion: profileVersion,
      contextCheckpoint: input.contextCheckpoint,
      activeOverlay,
    });
    if (!validation.valid) {
      manager.markStale(candidate.candidateId, validation.reason);
      candidateOutcome = {
        candidate: manager.currentCandidate() ?? candidate,
        action: "rejected",
        reason: validation.reason,
      };
      return false;
    }
    manager.markValidated(candidate.candidateId, validation.reason);

    if (input.policy === "shadow") {
      const previewState = candidate.kind === "durable_checkpoint"
        ? previewDurableCheckpointCandidate({ stateView: workingState, candidate })
        : applyMainFocusOverlay(workingState, overlayFromCandidate(candidate));
      const previewTurn = rebuildTurnInput(workingTurnInput, previewState, input.buildPrompt);
      const previewManifest = buildPromptContextManifest({ stateView: previewState, turnInput: previewTurn });
      manager.recordManifest(previewManifest, input.contextLimits.hardInputTokens);
      const previewBudget = await measure(input, previewTurn);
      manager.markDiscarded(candidate.candidateId, "shadow_policy_measured_without_adoption", {
        tokensBefore: currentBudget.measuredInputTokens,
        tokensAfter: previewBudget.measuredInputTokens,
        actualSavingsTokens: Math.max(
          0,
          currentBudget.measuredInputTokens - previewBudget.measuredInputTokens,
        ),
      });
      candidateOutcome = {
        candidate: manager.currentCandidate() ?? candidate,
        action: "measured",
        reason: "shadow_policy",
      };
      return false;
    }

    if (candidate.kind === "durable_checkpoint") {
      const generation = candidate.checkpointGeneration;
      const plan = candidate.checkpointPlan;
      if (!input.contextCheckpoint || !plan || !generation?.summary || generation.tokenCount === undefined) {
        manager.markStale(candidate.candidateId, "checkpoint_candidate_incomplete");
        candidateOutcome = {
          candidate: manager.currentCandidate() ?? candidate,
          action: "rejected",
          reason: "checkpoint_candidate_incomplete",
        };
        return false;
      }
      try {
        const committed = await input.contextCheckpoint.commit({
          plan,
          summary: generation.summary,
          tokenCount: generation.tokenCount,
          provider: input.provider.name,
          model: input.contextLimits.model,
        });
        adoptedCheckpoint = committed.checkpoint;
        adoptedCheckpointCandidate = candidate;
        const refreshed = input.applyAuthoritativeContext
          ? projectAgentStateViewForPrompt(input.applyAuthoritativeContext(committed.context))
          : previewDurableCheckpointCandidate({ stateView: workingState, candidate });
        workingState = applyMainFocusOverlay(refreshed, activeOverlay);
      } catch (error) {
        const reason = `checkpoint_commit_rejected:${error instanceof Error ? error.message : String(error)}`;
        manager.markStale(candidate.candidateId, reason);
        candidateOutcome = {
          candidate: manager.currentCandidate() ?? candidate,
          action: "rejected",
          reason,
        };
        return false;
      }
      mode = "stream_checkpoint";
    } else {
      const overlay = overlayFromCandidate(candidate);
      if (!overlay) {
        manager.markStale(candidate.candidateId, "focus_overlay_missing");
        return false;
      }
      activeOverlay = overlay;
      manager.setOverlay(overlay);
      workingState = applyMainFocusOverlay(workingState, overlay);
      mode = "step_ledger";
    }

    const tokensBefore = currentBudget.measuredInputTokens;
    workingTurnInput = rebuildTurnInput(workingTurnInput, workingState, input.buildPrompt);
    currentBudget = await measure(input, workingTurnInput);
    finalBudgetMeasured = true;
    manager.markAdopted(
      candidate.candidateId,
      waited ? "awaited_and_adopted" : "validated_and_adopted",
      { tokensBefore, tokensAfter: currentBudget.measuredInputTokens },
    );
    candidateOutcome = {
      candidate: manager.currentCandidate() ?? { ...candidate, status: "adopted" },
      action: "adopted",
      reason: validation.reason,
    };
    transformations.push({
      kind: candidate.kind === "durable_checkpoint" ? "stream_checkpoint_candidate" : "run_focus_candidate",
      from: "stable_exact_prefix",
      to: candidate.kind === "durable_checkpoint" ? "durable_checkpoint_and_exact_tail" : "context.run.focus_and_exact_tail",
      reason: waited ? "forced_barrier_wait" : "ready_candidate",
      ...(candidate.messagePrefixThroughSeq !== undefined
        ? { coveredToSeq: candidate.messagePrefixThroughSeq }
        : {}),
      sourceHash: candidate.canonicalSourceHashes["plan"]
        ?? candidate.canonicalSourceHashes["focus:previous"],
      tokensBefore,
      tokensAfter: currentBudget.measuredInputTokens,
    });
    return true;
  };

  const ready = manager.readyCandidate();
  if (ready) await considerCandidate(ready);

  if (atForcedBarrier(currentBudget)) {
    forcedRecovery = true;
    const preparing = manager.currentCandidate();
    if (preparing?.status === "preparing") {
      const awaited = await manager.awaitRelevant(preparing.jobKey);
      if (awaited) await considerCandidate(awaited, true);
    }
  }

  if (input.policy === "enforce" && currentBudget.softLimitExceeded) {
    const recovered = await recoverMainContextDeterministically({
      provider: input.provider,
      contextLimits: input.contextLimits,
      buildPrompt: input.buildPrompt,
      stateView: workingState,
      turnInput: workingTurnInput,
      budget: currentBudget,
    });
    workingState = recovered.stateView;
    workingTurnInput = recovered.turnInput;
    intermediateBudget = recovered.intermediateBudget;
    currentBudget = recovered.finalBudget;
    transformations.push(...recovered.transformations);
    projection = recovered.projection;
    streamProjection = recovered.streamProjection;
    finalBudgetMeasured ||= recovered.measured;
    if (recovered.mode !== "full" && mode === "full") mode = recovered.mode;
  }

  let synchronousAttempts = 0;
  while (
    input.policy === "enforce"
    && atForcedBarrier(currentBudget)
    && input.allowSynchronousSemanticRecovery
    && synchronousAttempts < 2
  ) {
    forcedRecovery = true;
    synchronousAttempts++;
    const job = createMainPreparationJob({
      provider: input.provider,
      laneId: manager.laneId,
      stateView: workingState,
      currentInputTokens: currentBudget.measuredInputTokens,
      predictedInputTokens: currentBudget.measuredInputTokens,
      recoveryTargetTokens: currentBudget.recoveryTargetTokens,
      contextLimits: input.contextLimits,
      modelProfileVersion: profileVersion,
      contextCheckpoint: input.contextCheckpoint,
      activeOverlay,
      synchronous: true,
    });
    if (!job) break;
    const synchronousCandidate = await manager.prepareSynchronously(job);
    if (!synchronousCandidate || !await considerCandidate(synchronousCandidate, true)) break;
    if (currentBudget.softLimitExceeded) {
      const recovered = await recoverMainContextDeterministically({
        provider: input.provider,
        contextLimits: input.contextLimits,
        buildPrompt: input.buildPrompt,
        stateView: workingState,
        turnInput: workingTurnInput,
        budget: currentBudget,
      });
      workingState = recovered.stateView;
      workingTurnInput = recovered.turnInput;
      intermediateBudget = recovered.intermediateBudget;
      currentBudget = recovered.finalBudget;
      transformations.push(...recovered.transformations);
      projection = recovered.projection ?? projection;
      streamProjection = recovered.streamProjection ?? streamProjection;
      finalBudgetMeasured ||= recovered.measured;
      if (mode === "full") mode = recovered.mode;
    }
  }

  const trigger = decideContextPreparationTrigger({
    measuredInputTokens: currentBudget.measuredInputTokens,
    preparationInputTokens: currentBudget.preparationInputTokens,
    softInputTokens: currentBudget.softInputTokens,
    preparationLeadTokens: leadTokens,
  });
  let backgroundStarted = false;
  let backgroundDeduplicated = false;
  if (input.allowBackgroundPreparation && trigger.triggered) {
    const job = createMainPreparationJob({
      provider: input.provider,
      laneId: manager.laneId,
      stateView: workingState,
      currentInputTokens: currentBudget.measuredInputTokens,
      predictedInputTokens: trigger.predictedInputTokens,
      recoveryTargetTokens: currentBudget.recoveryTargetTokens,
      contextLimits: input.contextLimits,
      modelProfileVersion: profileVersion,
      contextCheckpoint: input.contextCheckpoint,
      activeOverlay,
      synchronous: false,
    });
    if (job) {
      const started = manager.startBackground(job);
      backgroundStarted = started.status === "started";
      backgroundDeduplicated = started.status === "deduplicated";
    } else {
      manager.recordSkip("no_eligible_prefix", { triggerReason: trigger.reason });
    }
  } else if (input.allowBackgroundPreparation) {
    manager.recordSkip(trigger.reason, { predictedInputTokens: trigger.predictedInputTokens });
  }

  const finalManifest = buildPromptContextManifest({ stateView: workingState, turnInput: workingTurnInput });
  if (finalManifest.totalLocalEstimate !== candidateManifest.totalLocalEstimate) {
    manager.recordManifest(finalManifest, input.contextLimits.hardInputTokens);
  }
  const finalBarrier = forcedSynchronousBarrier(currentBudget);
  const recoveryExhausted = forcedRecovery && currentBudget.measuredInputTokens >= finalBarrier;
  if (currentBudget.admissionLimitExceeded || recoveryExhausted) {
    manager.recordLimitTermination({
      finalInputTokens: currentBudget.measuredInputTokens,
      admissionLimitTokens: currentBudget.admissionLimitTokens,
      forcedBarrierTokens: finalBarrier,
      recoveryExhausted,
    });
  }
  const currentCandidate = candidateOutcome.candidate ?? manager.currentCandidate();
  const backgroundUsage = currentCandidate?.background;
  const baseReceipt = buildFullContextCompilationReceipt(currentBudget, input.decisionAttempt);
  const receipt = enrichContextCompilationReceipt({
    ...baseReceipt,
    mode,
    candidateInputTokens: candidateBudget.measuredInputTokens,
    ...(intermediateBudget.measuredInputTokens !== candidateBudget.measuredInputTokens
      ? { intermediateInputTokens: intermediateBudget.measuredInputTokens }
      : {}),
    finalInputTokens: currentBudget.measuredInputTokens,
    softLimitExceeded: candidateBudget.softLimitExceeded,
    candidateHardLimitExceeded: candidateBudget.hardLimitExceeded,
    hardLimitExceeded: currentBudget.hardLimitExceeded,
    admitted: !currentBudget.admissionLimitExceeded,
    candidateCountSource: candidateBudget.countSource,
    toolProjectionPolicy: input.policy,
    targetReached: currentBudget.measuredInputTokens <= currentBudget.recoveryTargetTokens,
    needsEscalation: currentBudget.softLimitExceeded && !recoveryExhausted,
    ...(recoveryExhausted ? { recoveryExhausted: true } : {}),
    ...(adoptedCheckpoint && adoptedCheckpointCandidate?.checkpointGeneration ? {
      streamCheckpoint: {
        coveredFromSeq: adoptedCheckpoint.coveredFromSeq,
        coveredToSeq: adoptedCheckpoint.coveredToSeq,
        sourceEventCount: adoptedCheckpointCandidate.checkpointPlan!.selectedMessages.length
          + (adoptedCheckpointCandidate.checkpointPlan!.previousCheckpoint ? 1 : 0),
        sourceHash: adoptedCheckpoint.sourceHash,
        checkpointTokens: adoptedCheckpoint.tokenCount,
        cacheStatus: "generated",
        generationAttempts: adoptedCheckpointCandidate.checkpointGeneration.attempts.length,
      },
    } : {}),
    ...(streamProjection ? {
      streamProjection: {
        removedCandidateCount: streamProjection.removedCandidateCount,
        removedRecentWorkCount: streamProjection.removedRecentWorkCount,
        removedResourceCount: streamProjection.removedResourceCount,
        removedObservationCount: streamProjection.removedObservationCount,
        tokensBefore: intermediateBudget.measuredInputTokens,
        tokensAfter: currentBudget.measuredInputTokens,
      },
    } : {}),
    transformations,
  }, {
    preparationLeadTokens: leadTokens,
    manifestPolicyVersion: finalManifest.policyVersion,
    laneEstimates: finalManifest.laneEstimates,
    candidateLaneEstimates: candidateManifest.laneEstimates,
    toolSchemaTokens: finalManifest.toolSchemaTokens,
    forcedRecovery,
    ...(currentCandidate ? {
      candidate: {
        candidateId: currentCandidate.candidateId,
        laneId: currentCandidate.laneId,
        kind: currentCandidate.kind,
        status: currentCandidate.status,
        targetReached: currentCandidate.targetReached,
      },
    } : {}),
    candidateAction: candidateOutcome.action,
    ...(candidateOutcome.reason
      ? { candidateReason: candidateOutcome.reason }
      : currentCandidate?.failureReason
        ? { candidateReason: currentCandidate.failureReason }
        : currentCandidate?.lifecycleReason
          ? { candidateReason: currentCandidate.lifecycleReason }
          : {}),
    backgroundPreparation: {
      triggered: backgroundStarted || manager.currentCandidate()?.status === "preparing",
      deduplicated: backgroundDeduplicated,
      overlappedForeground: backgroundStarted || backgroundDeduplicated,
      ...(backgroundUsage ? {
        durationMs: backgroundUsage.durationMs,
        attempts: backgroundUsage.attempts,
        inputTokens: backgroundUsage.usage?.inputTokens,
        outputTokens: backgroundUsage.usage?.outputTokens,
        cachedInputTokens: backgroundUsage.usage?.cachedInputTokens,
        costUsd: backgroundUsage.cost?.totalCostUsd,
      } : {}),
    },
  });

  manager.consumeBackgroundUsage();
  return {
    candidateBudget,
    intermediateBudget,
    finalBudget: currentBudget,
    finalTurnInput: workingTurnInput,
    receipt,
    promptManifest: finalManifest,
    finalBudgetMeasured,
    ...(projection ? { projection } : {}),
    ...(streamProjection ? { streamProjection } : {}),
    ...(adoptedCheckpointCandidate?.checkpointPlan ? {
      streamCheckpoint: {
        plan: adoptedCheckpointCandidate.checkpointPlan,
        generation: adoptedCheckpointCandidate.checkpointGeneration,
        ...(adoptedCheckpoint ? { checkpoint: adoptedCheckpoint } : {}),
      },
    } : {}),
    preparationEvents: manager.drainEvents(),
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

function atForcedBarrier(report: ContextBudgetReport): boolean {
  return report.measuredInputTokens >= forcedSynchronousBarrier(report);
}

async function measure(
  input: Pick<PreparedMainAdmissionInput, "provider" | "contextLimits">,
  turnInput: LlmTurnInput,
): Promise<ContextBudgetReport> {
  return await measureTurnContext({
    provider: input.provider,
    turnInput,
    limits: input.contextLimits,
  });
}
