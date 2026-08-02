import type { ContextCheckpointPlan } from "ayati-context-engine";
import type { LlmProvider } from "../../core/contracts/provider.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type { AgentContextCheckpointCoordinator } from "../types.js";
import type { AgentStateView } from "../agent-runner/state-view.js";
import { generateStreamCheckpoint } from "../agent-runner/stream-checkpoint-generator.js";
import {
  checkpointCandidateBackground,
  checkpointSourceHashes,
  checkpointSourceRefs,
  checkpointSourceTokens,
} from "./main-checkpoint-candidate.js";
import { ContextPreparationJobError } from "./manager.js";
import type { ContextPreparationJob } from "./manager.js";
import type { ContextPreparationLaneId } from "./types.js";
import { CONTEXT_PREPARATION_POLICY_VERSION } from "./types.js";

export const CONVERSATION_CHECKPOINT_TARGET_TOKENS = 1_200;
export const CONVERSATION_CHECKPOINT_MIN_SAVINGS_TOKENS = 2_000;

export interface ContextMaintenanceStart {
  reason: "continuity_budget";
  protectFromSeq: number;
  continuityMaxTokens: number;
  unloadedRanges: Array<{ fromSeq: number; toSeq: number }>;
}

export interface ContextMaintenanceFinish {
  status: "completed" | "failed";
  reason: string;
  checkpointId?: string;
  coveredFromSeq?: number;
  coveredToSeq?: number;
}

export interface ContextMaintenanceLifecycle {
  enter(input: ContextMaintenanceStart): void;
  exit(input: ContextMaintenanceFinish): AgentStateView;
}

export interface PlannedContextMaintenance extends ContextMaintenanceStart {
  plan: ContextCheckpointPlan;
}

export async function planContextMaintenance(input: {
  stateView: AgentStateView;
  contextCheckpoint?: AgentContextCheckpointCoordinator;
}): Promise<PlannedContextMaintenance | undefined> {
  const core = input.stateView.context.core;
  if (!core.continuity.maintenanceRequired || !input.contextCheckpoint) {
    return undefined;
  }
  const protectFromSeq = protectedConversationTailStart(core);
  const plan = await input.contextCheckpoint.plan({
    protectFromSeq,
    requiredSavingsTokens: CONVERSATION_CHECKPOINT_MIN_SAVINGS_TOKENS,
    estimatedCheckpointTokens: CONVERSATION_CHECKPOINT_TARGET_TOKENS,
  });
  if (!plan.triggered) return undefined;
  return {
    reason: "continuity_budget",
    protectFromSeq,
    continuityMaxTokens: core.budget.continuityMaxTokens,
    unloadedRanges: core.continuity.unloadedRanges.map((range) => ({
      fromSeq: range.fromSeq,
      toSeq: range.toSeq,
    })),
    plan,
  };
}

export function createContextMaintenanceJob(input: {
  provider: LlmProvider;
  laneId: ContextPreparationLaneId;
  stateView: AgentStateView;
  currentInputTokens: number;
  contextLimits: ResolvedModelContextLimits;
  modelProfileVersion: string;
  maintenance: PlannedContextMaintenance;
}): ContextPreparationJob {
  const plan = input.maintenance.plan;
  const sourceTokens = checkpointSourceTokens(plan);
  const maximumUsefulTokens = Math.max(200, sourceTokens - 1);
  return {
    jobKey: [
      input.laneId,
      plan.planId,
      CONTEXT_PREPARATION_POLICY_VERSION,
      input.modelProfileVersion,
      "context_maintain",
    ].join(":"),
    kind: "durable_checkpoint",
    seed: {
      ...(plan.coveredToSeq !== undefined
        ? { messagePrefixThroughSeq: plan.coveredToSeq }
        : {}),
      canonicalSourceHashes: checkpointSourceHashes(plan),
      sourceRefs: checkpointSourceRefs(plan),
      requiredExactEvidenceRefs: [
        `run:${input.stateView.context.core.current.runId}`,
        `seq:${input.stateView.context.core.current.input.seq}`,
      ],
      policyVersion: CONTEXT_PREPARATION_POLICY_VERSION,
      modelProfileVersion: input.modelProfileVersion,
      ...(plan.previousCheckpoint?.checkpointId
        ? { checkpointBaseId: plan.previousCheckpoint.checkpointId }
        : {}),
      deterministicTransformations: ["conversation_checkpoint_and_exact_tail"],
      coveredSourceRefs: plan.selectedMessages.map((message) => `seq:${message.sequence}`),
      estimatedSavingsTokens: 0,
      estimatedFinalInputTokens: input.currentInputTokens,
      targetReached: false,
      checkpointPlan: plan,
    },
    prepare: async (context) => {
      const semantic = await context.runSemanticSynchronously(
        `checkpoint:${plan.planId}`,
        async () => await generateStreamCheckpoint({
          provider: input.provider,
          plan,
          maxInputTokens: input.contextLimits.hardInputTokens,
          maximumSummaryTokens: maximumUsefulTokens,
        }),
      );
      if (semantic.status !== "success" || !semantic.value) {
        throw new Error(semantic.error ?? "conversation checkpoint generation failed");
      }
      const generation = semantic.value;
      const background = checkpointCandidateBackground(generation, semantic.durationMs);
      if (generation.status !== "success" || !generation.summary || generation.tokenCount === undefined) {
        throw new ContextPreparationJobError(
          generation.errors.join("; ") || "conversation checkpoint generation failed",
          background,
        );
      }
      const estimatedSavingsTokens = Math.max(0, sourceTokens - generation.tokenCount);
      return {
        checkpointPlan: plan,
        checkpointGeneration: generation,
        estimatedSavingsTokens,
        estimatedFinalInputTokens: Math.max(
          0,
          input.currentInputTokens - estimatedSavingsTokens,
        ),
        targetReached: true,
        background,
      };
    },
  };
}

export function protectedConversationTailStart(
  core: AgentStateView["context"]["core"],
): number {
  // Compaction may consume older exact turns. Only the newest completed turn
  // must remain exact alongside the current input.
  for (let index = core.continuity.recentExact.length - 1; index >= 0; index--) {
    const event = core.continuity.recentExact[index]!;
    if (event.kind !== "assistant") return event.seq;
  }
  return core.continuity.recentExact[0]?.seq ?? core.current.input.seq;
}
