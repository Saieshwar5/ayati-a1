import type { MemoryRunHandle } from "../../memory/types.js";
import type {
  FailureRecord,
  LoopState,
  StepSummary,
  WorkState,
} from "../types.js";
import { compactWorkState } from "../state-compaction.js";
import type { AgentAction, AgentWorkStateUpdate } from "./decision.js";
import {
  isFileMutationRequest,
  latestFileMutationStep,
} from "./final-response-policy.js";
import { stepUsesFileMutationTool } from "./task-routing-policy.js";

export function isWorkStateUpdateToolAvailable(
  state: LoopState,
  workRunHandle: MemoryRunHandle | undefined,
): boolean {
  const hasTaskRun = Boolean(state.runId || workRunHandle?.runId);
  return hasTaskRun && state.runClass === "task" && state.workState.status === "not_done";
}

export function applyAgentWorkStateUpdate(
  state: LoopState,
  update: AgentWorkStateUpdate,
): { accepted: true } | { accepted: false; reason: string } {
  const summary = update.summary?.trim() || state.workState.summary;
  if (update.status === "done") {
    if (update.userInputNeeded?.trim()) {
      return { accepted: false, reason: "Done work state cannot also require user input." };
    }
    if ((update.blockers ?? []).some((item) => item.trim().length > 0)) {
      return { accepted: false, reason: "Done work state cannot include blockers." };
    }
    if (!hasWorkStateCompletionEvidence(state)) {
      return { accepted: false, reason: "Cannot mark work done without prior successful tool evidence, verified facts, evidence, or artifacts." };
    }
    state.workState = compactWorkState({
      ...state.workState,
      status: "done",
      summary,
      openWork: [],
      blockers: [],
      nextStep: undefined,
      userInputNeeded: undefined,
    });
    return { accepted: true };
  }

  if (update.status === "blocked") {
    const blockers = normalizeList(update.blockers);
    if (blockers.length === 0) {
      return { accepted: false, reason: "Blocked work state requires at least one blocker." };
    }
    state.workState = compactWorkState({
      ...state.workState,
      status: "blocked",
      summary,
      blockers,
      openWork: normalizeList(update.openWork).length > 0 ? normalizeList(update.openWork) : state.workState.openWork,
      nextStep: update.nextStep,
      userInputNeeded: undefined,
    });
    return { accepted: true };
  }

  if (update.status === "needs_user_input") {
    const userInputNeeded = update.userInputNeeded?.trim();
    if (!userInputNeeded) {
      return { accepted: false, reason: "Needs-user-input work state requires userInputNeeded." };
    }
    state.workState = compactWorkState({
      ...state.workState,
      status: "needs_user_input",
      summary,
      userInputNeeded,
      nextStep: userInputNeeded,
      openWork: normalizeList(update.openWork).length > 0 ? normalizeList(update.openWork) : state.workState.openWork,
      blockers: [],
    });
    return { accepted: true };
  }

  state.workState = compactWorkState({
    ...state.workState,
    status: "not_done",
    summary,
    ...(Array.isArray(update.openWork) ? { openWork: normalizeList(update.openWork) } : {}),
    ...(Array.isArray(update.blockers) ? { blockers: normalizeList(update.blockers) } : {}),
    ...(update.nextStep ? { nextStep: update.nextStep.trim() } : {}),
    userInputNeeded: undefined,
  });
  return { accepted: true };
}

export function createFailureRecordFromWorkStateUpdate(step: number, reason: string): FailureRecord {
  return {
    step,
    failureType: "validation_error",
    reason,
    blockedTargets: ["update_work_state"],
  };
}

export function canCompleteLocallyAfterAction(
  action: AgentAction,
  step: StepSummary,
  workState: WorkState,
  state: LoopState,
): boolean {
  return action.completion?.intent === "completion_candidate"
    && step.outcome === "success"
    && step.toolFailureCount === 0
    && (!isFileMutationRequest(state.userMessage) || stepUsesFileMutationTool(step))
    && !(workState.userInputNeeded?.trim())
    && (workState.blockers?.length ?? 0) === 0;
}

function hasWorkStateCompletionEvidence(state: LoopState): boolean {
  if (isFileMutationRequest(state.userMessage)) {
    const latestFailure = latestFileMutationStep(state.completedSteps, "failed");
    const latestSuccess = latestFileMutationStep(state.completedSteps, "success");
    return Boolean(latestSuccess && (!latestFailure || latestSuccess.step > latestFailure.step));
  }
  return state.completedSteps.some((step) => step.outcome === "success" && (step.toolSuccessCount ?? 0) > 0)
    || state.workState.verifiedFacts.length > 0
    || state.workState.evidence.length > 0
    || (state.workState.artifacts?.length ?? 0) > 0
    || (state.toolContext?.toolCalls ?? []).some((call) => call.status === "success");
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}
