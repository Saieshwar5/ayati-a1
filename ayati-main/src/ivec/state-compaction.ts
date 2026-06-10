import type { PromptTaskSummary } from "../memory/types.js";
import type { ControllerHistoryBundle } from "./run-state-manager.js";
import type { LoopState, StepSummary, TaskProgressState } from "./types.js";

const TASK_PROGRESS_LIMITS = {
  progressSummaryChars: 900,
  currentFocusChars: 240,
  userInputNeededChars: 320,
  completedMilestones: { count: 6, chars: 220 },
  openWork: { count: 5, chars: 220 },
  blockers: { count: 4, chars: 220 },
  keyFacts: { count: 8, chars: 220 },
  evidence: { count: 6, chars: 240 },
};

const DEPENDENT_TASK_LIMITS = {
  summaryChars: 700,
  progressSummaryChars: 700,
  currentFocusChars: 240,
  userInputNeededChars: 260,
  nextActionChars: 260,
  approachChars: 320,
  completedMilestones: { count: 5, chars: 200 },
  openWork: { count: 4, chars: 200 },
  blockers: { count: 4, chars: 200 },
  keyFacts: { count: 6, chars: 200 },
  evidence: { count: 4, chars: 220 },
  entityHints: { count: 6, chars: 120 },
  goalDoneWhen: { count: 5, chars: 180 },
  goalRequiredEvidence: { count: 5, chars: 180 },
  attachmentNames: { count: 8, chars: 120 },
};

const STEP_SUMMARY_LIMITS = {
  summaryChars: 900,
  evidenceSummaryChars: 600,
  newFacts: { count: 8, chars: 240 },
  evidenceItems: { count: 8, chars: 260 },
  blockedTargets: { count: 6, chars: 180 },
  usedRawArtifacts: { count: 8, chars: 240 },
};

export interface ControllerPromptState {
  taskProgress: TaskProgressState;
  dependentTaskSummary: PromptTaskSummary | null;
  controllerHistoryBundle?: ControllerHistoryBundle;
}

export function buildControllerPromptState(
  state: LoopState,
  controllerHistoryBundle?: ControllerHistoryBundle,
): ControllerPromptState {
  return {
    taskProgress: compactTaskProgress(state.taskProgress),
    dependentTaskSummary: compactDependentTaskSummary(state.dependentTaskSummary),
    controllerHistoryBundle,
  };
}

export function compactTaskProgress(progress: TaskProgressState): TaskProgressState {
  return {
    status: progress.status,
    progressSummary: compactText(progress.progressSummary, TASK_PROGRESS_LIMITS.progressSummaryChars),
    currentFocus: compactOptionalText(progress.currentFocus, TASK_PROGRESS_LIMITS.currentFocusChars),
    completedMilestones: compactStringList(progress.completedMilestones, TASK_PROGRESS_LIMITS.completedMilestones),
    openWork: compactStringList(progress.openWork, TASK_PROGRESS_LIMITS.openWork),
    blockers: compactStringList(progress.blockers, TASK_PROGRESS_LIMITS.blockers),
    keyFacts: compactStringList(progress.keyFacts, TASK_PROGRESS_LIMITS.keyFacts),
    evidence: compactStringList(progress.evidence, TASK_PROGRESS_LIMITS.evidence),
    userInputNeeded: compactOptionalText(progress.userInputNeeded, TASK_PROGRESS_LIMITS.userInputNeededChars),
  };
}

export function compactDependentTaskSummary(summary: PromptTaskSummary | null): PromptTaskSummary | null {
  if (!summary) {
    return null;
  }

  return {
    ...summary,
    objective: compactOptionalText(summary.objective, 320),
    summary: compactText(summary.summary, DEPENDENT_TASK_LIMITS.summaryChars),
    progressSummary: compactOptionalText(summary.progressSummary, DEPENDENT_TASK_LIMITS.progressSummaryChars),
    currentFocus: compactOptionalText(summary.currentFocus, DEPENDENT_TASK_LIMITS.currentFocusChars),
    userInputNeeded: compactOptionalText(summary.userInputNeeded, DEPENDENT_TASK_LIMITS.userInputNeededChars),
    nextAction: compactOptionalText(summary.nextAction, DEPENDENT_TASK_LIMITS.nextActionChars),
    approach: compactOptionalText(summary.approach, DEPENDENT_TASK_LIMITS.approachChars),
    sessionContextSummary: compactOptionalText(summary.sessionContextSummary, 400),
    assistantResponse: compactOptionalText(summary.assistantResponse, 400),
    completedMilestones: compactStringList(summary.completedMilestones, DEPENDENT_TASK_LIMITS.completedMilestones),
    openWork: compactStringList(summary.openWork, DEPENDENT_TASK_LIMITS.openWork),
    blockers: compactStringList(summary.blockers, DEPENDENT_TASK_LIMITS.blockers),
    keyFacts: compactStringList(summary.keyFacts, DEPENDENT_TASK_LIMITS.keyFacts),
    evidence: compactStringList(summary.evidence, DEPENDENT_TASK_LIMITS.evidence),
    entityHints: compactStringList(summary.entityHints, DEPENDENT_TASK_LIMITS.entityHints),
    goalDoneWhen: compactStringList(summary.goalDoneWhen, DEPENDENT_TASK_LIMITS.goalDoneWhen),
    goalRequiredEvidence: compactStringList(summary.goalRequiredEvidence, DEPENDENT_TASK_LIMITS.goalRequiredEvidence),
    attachmentNames: compactStringList(summary.attachmentNames, DEPENDENT_TASK_LIMITS.attachmentNames),
  };
}

export function compactStepSummaryForState(step: StepSummary): StepSummary {
  const {
    taskProgress: _taskProgress,
    ...withoutProgress
  } = step;

  return {
    ...withoutProgress,
    summary: compactText(step.summary, STEP_SUMMARY_LIMITS.summaryChars),
    newFacts: compactStringList(step.newFacts, STEP_SUMMARY_LIMITS.newFacts),
    evidenceSummary: compactOptionalText(step.evidenceSummary, STEP_SUMMARY_LIMITS.evidenceSummaryChars),
    evidenceItems: compactStringList(step.evidenceItems, STEP_SUMMARY_LIMITS.evidenceItems),
    blockedTargets: compactStringList(step.blockedTargets, STEP_SUMMARY_LIMITS.blockedTargets),
    usedRawArtifacts: compactStringList(step.usedRawArtifacts, STEP_SUMMARY_LIMITS.usedRawArtifacts),
  };
}

export function buildLoopStateSizeBreakdown(state: LoopState): Record<string, number> {
  const completedStepProgressChars = state.completedSteps.reduce((sum, step) => {
    return sum + measureJson((step as StepSummary & { taskProgress?: TaskProgressState }).taskProgress);
  }, 0);
  const persistedLikeState = buildPersistedLikeStateView(state);

  return {
    stateJson: measureJson(persistedLikeState),
    taskProgress: measureJson(state.taskProgress),
    completedSteps: measureJson(state.completedSteps),
    completedStepsTaskProgress: completedStepProgressChars,
    dependentTaskSummary: measureJson(state.dependentTaskSummary),
    failedApproaches: measureJson(state.failedApproaches),
    recentContextSearches: measureJson(state.recentContextSearches),
  };
}

function buildPersistedLikeStateView(state: LoopState): Omit<
  LoopState,
  "sessionHistory" | "recentTaskSummaries" | "activeSessionAttachments" | "recentSystemActivity"
> {
  const {
    sessionHistory: _sessionHistory,
    recentTaskSummaries: _recentTaskSummaries,
    activeSessionAttachments: _activeSessionAttachments,
    recentSystemActivity: _recentSystemActivity,
    ...persistedLikeState
  } = state;
  return persistedLikeState;
}

export function measureJson(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

export function compactText(value: unknown, maxChars: number): string {
  const text = normalizeText(String(value ?? ""));
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function compactOptionalText(value: unknown, maxChars: number): string | undefined {
  const text = compactText(value ?? "", maxChars);
  return text.length > 0 ? text : undefined;
}

function compactStringList(
  values: string[] | undefined,
  limits: { count: number; chars: number },
): string[] {
  return uniqueStrings(values ?? [])
    .map((value) => compactText(value, limits.chars))
    .filter((value) => value.length > 0)
    .slice(0, limits.count);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const compact = normalizeText(value);
    if (!compact || seen.has(compact)) {
      continue;
    }
    seen.add(compact);
    output.push(compact);
  }
  return output;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
