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

const STEP_SUMMARY_LIMITS = {
  summaryChars: 900,
  evidenceSummaryChars: 600,
  newFacts: { count: 8, chars: 240 },
  evidenceItems: { count: 8, chars: 260 },
  blockedTargets: { count: 6, chars: 180 },
  usedRawArtifacts: { count: 8, chars: 240 },
  expectedArtifacts: { count: 8, chars: 240 },
  expectedStateChangeChars: 360,
  verificationRationaleChars: 260,
  expectationCheckSummaryChars: 360,
};

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
    expectedArtifacts: compactStringList(step.expectedArtifacts, STEP_SUMMARY_LIMITS.expectedArtifacts),
    expectedStateChange: compactOptionalText(step.expectedStateChange, STEP_SUMMARY_LIMITS.expectedStateChangeChars),
    verificationRationale: compactOptionalText(step.verificationRationale, STEP_SUMMARY_LIMITS.verificationRationaleChars),
    expectationCheckSummary: compactOptionalText(step.expectationCheckSummary, STEP_SUMMARY_LIMITS.expectationCheckSummaryChars),
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
    failureHistory: measureJson(state.failureHistory),
  };
}

function buildPersistedLikeStateView(state: LoopState): Omit<
  LoopState,
  | "activeLearningContext"
  | "previousSessionSummary"
  | "personalMemorySnapshot"
  | "attentionShelf"
  | "recentExchanges"
  | "recentTaskSummaries"
  | "activeSessionAttachments"
> {
  const {
    recentExchanges: _recentExchanges,
    recentTaskSummaries: _recentTaskSummaries,
    activeSessionAttachments: _activeSessionAttachments,
    activeLearningContext: _activeLearningContext,
    previousSessionSummary: _previousSessionSummary,
    personalMemorySnapshot: _personalMemorySnapshot,
    attentionShelf: _attentionShelf,
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
