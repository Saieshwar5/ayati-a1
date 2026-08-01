import type { HarnessContextInput } from "../harness-context.js";
import type { AgentLoopDeps, LoopState, WorkState } from "../types.js";
import { compactWorkState } from "../state-compaction.js";
import { buildPromptToolCallsForRun } from "./run-tool-call-context.js";
import type {
  RunContextMaintenancePlan,
  RunContextMaintenanceSelection,
} from "./run-context-maintenance-contracts.js";
import {
  applyRunContextMaintenanceSelection,
  buildRunContextMaintenancePlan,
  hasRunContextMaintenanceOpportunity,
} from "./run-context-maintenance-planner.js";
import {
  enterRunMaintainMode,
  recordRunMaintainAttempt,
  restoreVirtualModeAfterRunMaintenance,
} from "./virtual-mode.js";

export const MAX_RUN_CONTEXT_MAINTENANCE_ATTEMPTS = 2;

export interface AppliedRunContextMaintenanceResult {
  accepted: true;
  context?: HarnessContextInput;
  plan: RunContextMaintenancePlan;
  transformationCount: number;
  estimatedSavingsTokens: number;
  targetReached: boolean;
}

export interface RejectedRunContextMaintenanceResult {
  accepted: false;
  reason: string;
}

export type HandledRunContextMaintenanceResult =
  | (AppliedRunContextMaintenanceResult & {
      status: "applied";
      usedFallback: boolean;
      priorRejection?: string;
    })
  | {
      status: "retry";
      reason: string;
      attempt: number;
    }
  | {
      status: "failed";
      reason: string;
    };

export function planRunContextMaintenance(
  state: LoopState,
): RunContextMaintenancePlan | undefined {
  const receipt = state.contextPressure?.latestReceipt;
  if (
    !receipt
    || receipt.decisionAttempt !== 1
    || !receipt.softLimitExceeded
    || receipt.candidateInputTokens <= receipt.recoveryTargetTokens
  ) {
    return undefined;
  }
  const calls = buildPromptToolCallsForRun(state.toolContext?.toolCalls) ?? [];
  const plan = buildRunContextMaintenancePlan({
    calls,
    currentOverlay: state.runContextProjection,
    workState: state.workState,
    workStateRevision: state.workStateRuntime.revision,
    candidateInputTokens: receipt.candidateInputTokens,
    recoveryTargetTokens: receipt.recoveryTargetTokens,
  });
  return hasRunContextMaintenanceOpportunity(plan, state.runContextProjection)
    ? plan
    : undefined;
}

export function enterRunContextMaintenance(
  state: LoopState,
  plan: RunContextMaintenancePlan,
): void {
  state.virtualMode = enterRunMaintainMode(state.virtualMode, plan, state.iteration);
  state.runContextMaintenanceBudgetCredits = (state.runContextMaintenanceBudgetCredits ?? 0) + 1;
}

export async function applyRunContextMaintenance(input: {
  state: LoopState;
  selection: RunContextMaintenanceSelection;
  checkpointWorkState: NonNullable<AgentLoopDeps["checkpointWorkState"]>;
  afterStep: number;
  at: string;
}): Promise<AppliedRunContextMaintenanceResult | RejectedRunContextMaintenanceResult> {
  const progress = input.state.virtualMode.runMaintain;
  if (input.state.virtualMode.active !== "run.maintain" || !progress) {
    return { accepted: false, reason: "Run-context maintenance is not active." };
  }
  const calls = buildPromptToolCallsForRun(input.state.toolContext?.toolCalls) ?? [];
  const nextWorkState = compactWorkState({
    status: "in_progress",
    summary: input.selection.workState.summary,
    plan: input.selection.workState.plan,
    importantContext: input.selection.workState.importantContext,
    ...(input.selection.workState.nextAction
      ? { nextAction: input.selection.workState.nextAction }
      : {}),
  });
  let applied;
  try {
    applied = applyRunContextMaintenanceSelection({
      plan: progress.plan,
      calls,
      currentOverlay: input.state.runContextProjection,
      selection: input.selection,
      persistedWorkStateRevision: input.state.workStateRuntime.revision + 1,
      iteration: input.state.iteration,
    });
  } catch (error) {
    return {
      accepted: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const checkpoint = await input.checkpointWorkState({
    reason: "context_pressure",
    workState: nextWorkState,
    runtime: input.state.workStateRuntime,
    afterStep: input.afterStep,
    at: input.at,
  });
  input.state.workState = nextWorkState;
  input.state.workStateRuntime = checkpoint.runtime;
  input.state.runContextProjection = {
    ...applied.overlay,
    workStateRevision: checkpoint.runtime.revision,
  };
  input.state.virtualMode = restoreVirtualModeAfterRunMaintenance(input.state.virtualMode);
  return {
    accepted: true,
    ...(checkpoint.context ? { context: checkpoint.context } : {}),
    plan: progress.plan,
    transformationCount: applied.transformations.length,
    estimatedSavingsTokens: applied.overlay.estimatedSavingsTokens,
    targetReached: applied.overlay.targetReached,
  };
}

export async function handleRunContextMaintenanceDecision(input: {
  state: LoopState;
  selection: RunContextMaintenanceSelection;
  checkpointWorkState: NonNullable<AgentLoopDeps["checkpointWorkState"]>;
  afterStep: number;
  at: string;
}): Promise<HandledRunContextMaintenanceResult> {
  // A maintenance decision consumes a provider turn, but not one of the
  // task's bounded work iterations. Credit it exactly once whether the
  // selection is accepted, rejected, or replaced by the safe fallback.
  input.state.runContextMaintenanceBudgetCredits = (
    input.state.runContextMaintenanceBudgetCredits ?? 0
  ) + 1;
  const result = await applyRunContextMaintenance(input);
  if (result.accepted) {
    return { ...result, status: "applied", usedFallback: false };
  }
  input.state.virtualMode = recordRunMaintainAttempt(input.state.virtualMode);
  const attempt = input.state.virtualMode.runMaintain?.attempts ?? 0;
  if (attempt < MAX_RUN_CONTEXT_MAINTENANCE_ATTEMPTS) {
    return { status: "retry", reason: result.reason, attempt };
  }
  try {
    const fallback = await applyRunContextMaintenance({
      ...input,
      selection: defaultRunContextMaintenanceSelection(input.state),
    });
    if (!fallback.accepted) {
      return { status: "failed", reason: fallback.reason };
    }
    return {
      ...fallback,
      status: "applied",
      usedFallback: true,
      priorRejection: result.reason,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function defaultRunContextMaintenanceSelection(
  state: LoopState,
): RunContextMaintenanceSelection {
  const progress = state.virtualMode.runMaintain;
  if (state.virtualMode.active !== "run.maintain" || !progress) {
    throw new Error("Run-context maintenance is not active.");
  }
  const workState = fallbackWorkState(state.workState, state.toolContext?.toolCalls ?? []);
  return {
    maintenanceId: progress.plan.maintenanceId,
    expectedWorkStateRevision: progress.plan.expectedWorkStateRevision,
    workState: {
      reason: "context_pressure",
      summary: workState.summary,
      plan: workState.plan,
      importantContext: workState.importantContext,
      ...(workState.nextAction ? { nextAction: workState.nextAction } : {}),
    },
    keepExactRefs: [],
    keepCompactRefs: [],
    releaseRefs: [],
  };
}

function fallbackWorkState(
  current: WorkState,
  calls: NonNullable<LoopState["toolContext"]>["toolCalls"],
): WorkState {
  const verifiedCalls = (calls ?? []).filter((call) => (
    call.status === "success"
    && (call.verification?.status === "passed" || call.verificationPassed === true)
  )).length;
  const hasMeaningfulSummary = current.summary.trim().length > 0
    && current.summary !== "Run started.";
  return compactWorkState({
    status: "in_progress",
    summary: hasMeaningfulSummary
      ? current.summary
      : verifiedCalls > 0
        ? `${verifiedCalls} verified tool call${verifiedCalls === 1 ? "" : "s"} completed; the run remains in progress.`
        : "The run remains in progress; no completed work is being claimed.",
    plan: current.plan,
    importantContext: current.importantContext,
    nextAction: current.nextAction
      ?? "Continue from the latest deterministically verified run state.",
  });
}
