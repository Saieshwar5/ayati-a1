import type { ContextCheckpointPlan } from "ayati-context-engine";
import type { LlmCostEstimate, LlmTokenUsage } from "../../core/contracts/llm-protocol.js";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import { projectStreamMessageEvent } from "../agent-runner/agent-context-events.js";
import { buildCoreCapsule } from "../agent-runner/core-capsule.js";
import type { AgentPromptStateView } from "../agent-runner/prompt-context.js";
import { canonicalHash } from "./canonical.js";
import type {
  ContextPreparationBackgroundUsage,
  ContextPreparationCandidate,
} from "./types.js";

export function previewDurableCheckpointCandidate(input: {
  stateView: AgentPromptStateView;
  candidate: ContextPreparationCandidate;
}): AgentPromptStateView {
  const plan = input.candidate.checkpointPlan;
  const summary = input.candidate.checkpointGeneration?.summary;
  if (!plan || !summary || plan.coveredFromSeq === undefined || plan.coveredToSeq === undefined) {
    return input.stateView;
  }
  return {
    ...input.stateView,
    context: {
      ...input.stateView.context,
      core: buildCoreCapsule({
        revision: input.stateView.context.core.revision,
        runId: input.stateView.context.core.current.runId,
        checkpoint: {
          coveredFromSeq: plan.coveredFromSeq,
          coveredToSeq: plan.coveredToSeq,
          summary,
          exactAnchors: checkpointAnchors(summary),
          createdAt: input.candidate.updatedAt,
        },
        timeline: plan.exactTail.map((message) => projectStreamMessageEvent(
          message,
          message.sequence === input.stateView.context.core.current.input.seq,
        )),
        ...(input.stateView.context.core.current.routing
          ? { routing: input.stateView.context.core.current.routing }
          : {}),
        ...(input.stateView.context.core.current.activeDocuments
          ? {
              activeDocuments:
                input.stateView.context.core.current.activeDocuments,
            }
          : {}),
        continuityMaxTokens: input.stateView.context.core.budget.continuityMaxTokens,
      }),
    },
  };
}

export function checkpointSourceHashes(plan: ContextCheckpointPlan): Record<string, string> {
  const hashes: Record<string, string> = {
    plan: plan.sourceHash ?? canonicalHash(plan.selectedMessages),
  };
  for (const message of plan.selectedMessages) {
    hashes[`seq:${message.sequence}`] = canonicalHash(message);
  }
  if (plan.previousCheckpoint) {
    hashes[`checkpoint:${plan.previousCheckpoint.checkpointId}`] = canonicalHash(plan.previousCheckpoint);
  }
  return hashes;
}

export function checkpointSourceRefs(plan: ContextCheckpointPlan): string[] {
  return [...new Set([
    ...plan.selectedMessages.map((message) => `seq:${message.sequence}`),
    ...(plan.previousCheckpoint?.exactAnchors ?? []).map((seq) => `seq:${seq}`),
  ])].sort();
}

export function checkpointSourceTokens(plan: ContextCheckpointPlan): number {
  return estimateTextTokens(JSON.stringify({
    previousCheckpoint: plan.previousCheckpoint?.summary ?? null,
    messages: plan.selectedMessages,
  }));
}

export function checkpointCandidateBackground(
  generation: NonNullable<ContextPreparationCandidate["checkpointGeneration"]>,
  durationMs: number,
): ContextPreparationBackgroundUsage {
  const usage = aggregateCheckpointUsage(generation);
  const cost = aggregateCheckpointCost(generation);
  return {
    durationMs,
    attempts: generation.attempts.length,
    ...(usage ? { usage } : {}),
    ...(cost ? { cost } : {}),
  };
}

function aggregateCheckpointUsage(
  generation: NonNullable<ContextPreparationCandidate["checkpointGeneration"]>,
): LlmTokenUsage | undefined {
  const values = generation.attempts.flatMap((attempt) => attempt.usage ? [attempt.usage] : []);
  const last = values.at(-1);
  if (!last) return undefined;
  return {
    provider: last.provider,
    model: last.model,
    inputTokens: values.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: values.reduce((sum, value) => sum + value.outputTokens, 0),
    totalTokens: values.reduce((sum, value) => sum + value.totalTokens, 0),
    ...(values.some((value) => value.cachedInputTokens !== undefined)
      ? { cachedInputTokens: values.reduce((sum, value) => sum + (value.cachedInputTokens ?? 0), 0) }
      : {}),
    exact: values.every((value) => value.exact),
  };
}

function aggregateCheckpointCost(
  generation: NonNullable<ContextPreparationCandidate["checkpointGeneration"]>,
): LlmCostEstimate | undefined {
  const values = generation.attempts.flatMap((attempt) => attempt.cost ? [attempt.cost] : []);
  const last = values.at(-1);
  if (!last) return undefined;
  return {
    currency: "USD",
    inputCostUsd: values.reduce((sum, value) => sum + value.inputCostUsd, 0),
    cachedInputCostUsd: values.reduce((sum, value) => sum + value.cachedInputCostUsd, 0),
    outputCostUsd: values.reduce((sum, value) => sum + value.outputCostUsd, 0),
    totalCostUsd: values.reduce((sum, value) => sum + value.totalCostUsd, 0),
    pricingSource: last.pricingSource,
  };
}

function checkpointAnchors(
  summary: NonNullable<ContextPreparationCandidate["checkpointGeneration"]>["summary"],
): number[] {
  if (!summary) return [];
  return [...new Set([
    ...summary.userRequests,
    ...summary.constraints,
    ...summary.decisions,
    ...summary.corrections,
    ...summary.importantFacts,
    ...summary.unresolvedQuestions,
    ...summary.references,
  ].map((statement) => statement.seq))].sort((left, right) => left - right);
}
