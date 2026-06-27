import {
  createActionId,
  type CompletePreparedRunInput,
  type RunActionWrite,
  type RunId,
  type TaskRunSummaryFile,
  type TaskStateFile,
  type TaskStatus,
  type WorkId,
} from "../daily-session/index.js";
import type {
  HarnessRunResultForContext,
  HarnessStepSummaryForContext,
  HarnessWorkStateForContext,
} from "../contracts.js";

export interface BuildDailySessionRunCommitInput {
  sessionId: string;
  workId: WorkId;
  runId: RunId;
  result: HarnessRunResultForContext;
  at: string;
}

export function buildDailySessionRunCommitInput(input: BuildDailySessionRunCommitInput): CompletePreparedRunInput {
  const workState = input.result.workState ?? fallbackWorkState(input.result);
  const state = buildTaskState(input.workId, workState, input.result);
  const actions = buildRunActions(input.workId, input.runId, input.result.completedSteps ?? [], input.at);
  const runSummary = buildRunSummary({
    runId: input.runId,
    workId: input.workId,
    result: input.result,
    state,
    actions,
    at: input.at,
  });

  return {
    sessionId: input.sessionId,
    workId: input.workId,
    runId: input.runId,
    state,
    runSummary,
    actions,
    finalOutput: {
      schemaVersion: 1,
      runId: input.runId,
      workId: input.workId,
      kind: "final",
      content: {
        type: input.result.type,
        status: input.result.status,
        content: input.result.content,
        totalIterations: input.result.totalIterations,
        totalToolCalls: input.result.totalToolCalls,
        runPath: input.result.runPath,
        workRunId: input.result.workRunId,
      },
      createdAt: input.at,
    },
    assistantMessage: input.result.content,
    commitSummary: runSummary.summary,
    completed: state.completed,
    open: state.open,
    status: state.status,
    at: input.at,
  };
}

function buildTaskState(
  workId: WorkId,
  workState: HarnessWorkStateForContext,
  result: HarnessRunResultForContext,
): TaskStateFile {
  const status = toTaskStatus(workState, result);
  const next = workState.nextStep?.trim() || result.taskSummary?.nextAction;
  const open = status === "done" || status === "failed"
    ? []
    : normalizeList(workState.openWork?.length ? workState.openWork : next ? [next] : []);
  const blockers = normalizeList([
    ...(workState.blockers ?? []),
    ...(workState.userInputNeeded ? [workState.userInputNeeded] : []),
  ]);
  return {
    schemaVersion: 1,
    workId,
    status,
    completed: normalizeList([
      ...(result.taskSummary?.completedMilestones ?? []),
      ...(result.completedSteps ?? [])
        .filter((step) => step.outcome === "success")
        .map((step) => step.summary),
    ]),
    open,
    ...(blockers.length > 0 ? { blockers } : {}),
    facts: normalizeList(workState.verifiedFacts).map((fact) => ({
      text: fact,
      source: "workState.verifiedFacts",
    })),
    ...(next && status !== "done" && status !== "failed" ? { next } : {}),
  };
}

function buildRunActions(
  workId: WorkId,
  runId: RunId,
  steps: HarnessStepSummaryForContext[],
  at: string,
): RunActionWrite[] {
  return steps.map((step, index) => {
    const actionId = createActionId(index + 1);
    return {
      action: {
        schemaVersion: 1,
        actionId,
        runId,
        workId,
        tool: normalizeList(step.toolsUsed).join(",") || "agent_step",
        input: {
          step: step.step,
          executionContract: step.executionContract,
        },
        status: step.outcome === "success" ? "success" : "failed",
        summary: step.summary,
        createdAt: at,
      },
      output: JSON.stringify({
        step: step.step,
        outcome: step.outcome,
        summary: step.summary,
        newFacts: step.newFacts,
        artifacts: step.artifacts,
        evidenceSummary: step.evidenceSummary,
        evidenceItems: step.evidenceItems,
        workState: step.workState,
      }, null, 2),
      outputExtension: "json",
    };
  });
}

function buildRunSummary(input: {
  runId: RunId;
  workId: WorkId;
  result: HarnessRunResultForContext;
  state: TaskStateFile;
  actions: RunActionWrite[];
  at: string;
}): TaskRunSummaryFile {
  return {
    schemaVersion: 1,
    runId: input.runId,
    workId: input.workId,
    status: toRunSummaryStatus(input.result),
    summary: input.result.taskSummary?.summary || input.result.content || "Completed run.",
    completed: input.state.completed,
    open: input.state.open,
    actions: input.actions.map((action) => action.action.actionId),
    createdAt: input.at,
  };
}

function toTaskStatus(workState: HarnessWorkStateForContext, result: HarnessRunResultForContext): TaskStatus {
  if (result.status === "failed") {
    return "failed";
  }
  if (result.status === "stuck") {
    return "blocked";
  }
  if (workState.status === "done") {
    return "done";
  }
  if (workState.status === "blocked" || workState.status === "needs_user_input") {
    return "blocked";
  }
  return "active";
}

function toRunSummaryStatus(result: HarnessRunResultForContext): TaskRunSummaryFile["status"] {
  if (result.status === "failed") {
    return "failed";
  }
  if (result.status === "stuck") {
    return "blocked";
  }
  if (result.type === "feedback") {
    return "needs_user_input";
  }
  return "completed";
}

function fallbackWorkState(result: HarnessRunResultForContext): HarnessWorkStateForContext {
  return {
    status: result.status === "completed" ? "done" : "blocked",
    summary: result.content,
    openWork: result.taskSummary?.openWork ?? [],
    blockers: result.taskSummary?.blockers ?? [],
    verifiedFacts: result.taskSummary?.keyFacts ?? [],
    evidence: result.taskSummary?.evidence ?? [],
    nextStep: result.taskSummary?.nextAction,
  };
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
