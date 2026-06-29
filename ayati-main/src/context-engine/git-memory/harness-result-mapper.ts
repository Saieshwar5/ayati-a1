import type {
  HarnessRunResultForContext,
  HarnessStepSummaryForContext,
  HarnessTaskSummaryForContext,
  HarnessWorkStateForContext,
} from "../contracts.js";
import type {
  CommitGitMemoryTaskRunActionInput,
  CommitGitMemoryTaskRunEvidenceInput,
  CommitGitMemoryTaskRunInput,
} from "./session-store.js";
import type {
  GitMemoryConversationSeqRange,
  GitMemoryRunId,
  GitMemoryRunStatus,
  GitMemorySessionId,
  GitMemoryTaskId,
  GitMemoryTaskStatus,
} from "./schema.js";

export type GitMemoryHarnessTaskStatus = "open" | "done" | "blocked" | "needs_user_input";

export type GitMemoryHarnessTaskSummaryForContext = HarnessTaskSummaryForContext & {
  taskStatus?: GitMemoryHarnessTaskStatus;
  userInputNeeded?: string;
};

export type GitMemoryHarnessRunResultForContext = Omit<HarnessRunResultForContext, "taskSummary"> & {
  taskSummary?: GitMemoryHarnessTaskSummaryForContext;
};

export interface BuildGitMemoryTaskRunCommitInput {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  runId?: GitMemoryRunId;
  result: GitMemoryHarnessRunResultForContext;
  conversationRefs: GitMemoryConversationSeqRange[];
  at: string;
  startedAt?: string;
  changedFiles?: string[];
}

export function buildGitMemoryTaskRunCommitInput(
  input: BuildGitMemoryTaskRunCommitInput,
): CommitGitMemoryTaskRunInput {
  const workState = input.result.workState ?? fallbackWorkState(input.result);
  const taskStatus = toTaskStatus(workState, input.result);
  const runStatus = toRunStatus(workState, input.result);
  const summary = firstNonEmpty([
    input.result.taskSummary?.summary,
    workState.summary,
    input.result.content,
    "Completed run.",
  ]);
  const next = firstNonEmpty([
    workState.nextStep,
    input.result.taskSummary?.nextAction,
    workState.userInputNeeded,
    input.result.taskSummary?.userInputNeeded,
    taskStatus === "done" ? "No next step." : undefined,
  ]);
  const completed = buildCompleted(input.result);
  const open = taskStatus === "done" ? [] : buildOpen(workState, input.result, next);
  const blockers = buildBlockers(workState, input.result);

  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    ...(input.runId ? { runId: input.runId } : {}),
    status: runStatus,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    completedAt: input.at,
    conversationRefs: input.conversationRefs,
    summary,
    ...(input.result.content.trim() ? { assistantResponse: input.result.content } : {}),
    actions: buildRunActions(input.result.completedSteps ?? [], input.at),
    evidence: buildRunEvidence(input.result.completedSteps ?? []),
    ...(input.result.taskAssets?.length ? { assets: input.result.taskAssets } : {}),
    toolCallCount: input.result.totalToolCalls,
    changedFiles: input.changedFiles ?? buildChangedFiles(input.result),
    newFacts: buildNewFacts(workState, input.result),
    ...(next ? { next } : {}),
    state: {
      status: taskStatus,
      summary: firstNonEmpty([workState.summary, summary]),
      completed,
      open,
      blockers,
      next: next || "No next step.",
    },
  };
}

function buildRunEvidence(
  steps: HarnessStepSummaryForContext[],
): CommitGitMemoryTaskRunEvidenceInput[] {
  return steps.map((step) => ({
    step: step.step,
    tool: normalizeList(step.toolsUsed).join(",") || "agent_step",
    status: toActionStatus(step.outcome),
    summary: step.summary,
    ...(step.evidenceSummary ? { evidenceRef: step.evidenceSummary } : {}),
    artifacts: normalizeList(step.artifacts),
    facts: normalizeList([
      ...step.newFacts,
      ...(step.evidenceItems ?? []),
    ]),
    accessModes: step.evidenceSummary || (step.evidenceItems ?? []).length > 0 ? ["summary"] : [],
    source: { kind: "harness-step" },
  }));
}

function buildRunActions(
  steps: HarnessStepSummaryForContext[],
  at: string,
): CommitGitMemoryTaskRunActionInput[] {
  return steps.map((step) => ({
    tool: normalizeList(step.toolsUsed).join(",") || "agent_step",
    status: toActionStatus(step.outcome),
    summary: step.summary,
    startedAt: at,
    completedAt: at,
    ...(step.evidenceSummary ? { evidenceRef: step.evidenceSummary } : {}),
  }));
}

function toRunStatus(
  workState: HarnessWorkStateForContext,
  result: GitMemoryHarnessRunResultForContext,
): GitMemoryRunStatus {
  if (result.status === "failed") {
    return "failed";
  }
  if (result.status === "stuck") {
    return "blocked";
  }
  if (workState.status === "needs_user_input" || result.type === "feedback") {
    return "needs_user_input";
  }
  return "completed";
}

function toTaskStatus(
  workState: HarnessWorkStateForContext,
  result: GitMemoryHarnessRunResultForContext,
): GitMemoryTaskStatus {
  if (result.taskSummary?.taskStatus === "done" || workState.status === "done") {
    return "done";
  }
  if (
    result.taskSummary?.taskStatus === "blocked"
    || result.taskSummary?.taskStatus === "needs_user_input"
    || workState.status === "blocked"
    || workState.status === "needs_user_input"
    || result.status === "failed"
    || result.status === "stuck"
  ) {
    return "blocked";
  }
  return "in_progress";
}

function toActionStatus(outcome: string): CommitGitMemoryTaskRunActionInput["status"] {
  if (outcome === "success") {
    return "completed";
  }
  if (outcome === "skipped") {
    return "skipped";
  }
  return "failed";
}

function fallbackWorkState(result: GitMemoryHarnessRunResultForContext): HarnessWorkStateForContext {
  const taskStatus = result.taskSummary?.taskStatus;
  const hasOpenWork = (result.taskSummary?.openWork ?? []).some((item) => item.trim().length > 0);
  return {
    status: taskStatus === "done"
      ? "done"
      : taskStatus === "blocked" || result.status === "stuck"
        ? "blocked"
        : taskStatus === "needs_user_input" || result.type === "feedback"
          ? "needs_user_input"
          : result.status === "completed" && !hasOpenWork
            ? "done"
            : result.status === "completed"
              ? "not_done"
              : "blocked",
    summary: result.taskSummary?.summary || result.content || "Completed run.",
    openWork: result.taskSummary?.openWork ?? [],
    blockers: result.taskSummary?.blockers ?? [],
    verifiedFacts: result.taskSummary?.keyFacts ?? [],
    evidence: result.taskSummary?.evidence ?? [],
    nextStep: result.taskSummary?.nextAction,
    userInputNeeded: result.taskSummary?.userInputNeeded,
  };
}

function buildCompleted(result: GitMemoryHarnessRunResultForContext): string[] {
  return normalizeList([
    ...(result.taskSummary?.completedMilestones ?? []),
    ...(result.completedSteps ?? [])
      .filter((step) => step.outcome === "success")
      .map((step) => step.summary),
  ]);
}

function buildOpen(
  workState: HarnessWorkStateForContext,
  result: GitMemoryHarnessRunResultForContext,
  next: string | undefined,
): string[] {
  const open = normalizeList([
    ...(workState.openWork ?? []),
    ...(result.taskSummary?.openWork ?? []),
  ]);
  return open.length > 0 ? open : normalizeList(next ? [next] : []);
}

function buildBlockers(
  workState: HarnessWorkStateForContext,
  result: GitMemoryHarnessRunResultForContext,
): string[] {
  return normalizeList([
    ...(workState.blockers ?? []),
    ...(result.taskSummary?.blockers ?? []),
    workState.userInputNeeded,
    result.taskSummary?.userInputNeeded,
  ]);
}

function buildNewFacts(
  workState: HarnessWorkStateForContext,
  result: GitMemoryHarnessRunResultForContext,
): string[] {
  return normalizeList([
    ...(workState.verifiedFacts ?? []),
    ...(result.taskSummary?.keyFacts ?? []),
    ...(result.completedSteps ?? []).flatMap((step) => step.newFacts),
  ]);
}

function buildChangedFiles(result: GitMemoryHarnessRunResultForContext): string[] {
  return normalizeList([
    ...(result.completedSteps ?? []).flatMap((step) => step.artifacts),
  ]);
}

function firstNonEmpty(values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeList(values: Array<string | undefined> | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
