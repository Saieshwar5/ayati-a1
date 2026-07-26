import type { LoopState, StepSummary, ToolContextState, ToolObservation, WorkState } from "./types.js";

const WORK_STATE_LIMITS = {
  summaryChars: 1_000,
  planItems: 12,
  planIdChars: 32,
  planTaskChars: 240,
  importantContextItems: 12,
  importantContextValueChars: 320,
  importantContextRefChars: 500,
  nextActionChars: 320,
};

const LOOP_STATE_LIMITS = {
  workingNotes: { count: 12, chars: 420 },
  toolContextCards: 5,
  toolContextCardChars: 4_000,
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

export function compactWorkState(workState: WorkState): WorkState {
  const seenPlanIds = new Set<string>();
  return {
    status: workState.status,
    summary: compactText(workState.summary, WORK_STATE_LIMITS.summaryChars),
    plan: workState.plan
      .map((item) => ({
        id: compactText(item.id, WORK_STATE_LIMITS.planIdChars),
        task: compactText(item.task, WORK_STATE_LIMITS.planTaskChars),
        status: item.status,
      }))
      .filter((item) => {
        if (!item.id || !item.task || seenPlanIds.has(item.id)) return false;
        seenPlanIds.add(item.id);
        return true;
      })
      .slice(0, WORK_STATE_LIMITS.planItems),
    importantContext: workState.importantContext
      .map((item) => ({
        kind: item.kind,
        value: compactText(item.value, WORK_STATE_LIMITS.importantContextValueChars),
        ...(item.ref
          ? { ref: compactText(item.ref, WORK_STATE_LIMITS.importantContextRefChars) }
          : {}),
      }))
      .filter((item) => item.value.length > 0)
      .slice(0, WORK_STATE_LIMITS.importantContextItems),
    nextAction: compactOptionalText(workState.nextAction, WORK_STATE_LIMITS.nextActionChars),
  };
}

export function compactStepSummaryForState(step: StepSummary): StepSummary {
  const {
    workState: _workState,
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
  const completedStepWorkStateChars = state.completedSteps.reduce((sum, step) => {
    return sum + measureJson((step as StepSummary & { workState?: WorkState }).workState);
  }, 0);
  const persistedLikeState = buildPersistedLikeStateView(state);

  return {
    stateJson: measureJson(persistedLikeState),
    workState: measureJson(state.workState),
    completedSteps: measureJson(state.completedSteps),
    completedStepsWorkState: completedStepWorkStateChars,
    failureHistory: measureJson(state.failureHistory),
    toolContext: measureJson(state.toolContext),
    workingNotes: measureJson(state.workingNotes),
  };
}

function buildPersistedLikeStateView(state: LoopState): Omit<
  LoopState,
  | "harnessContext"
> {
  const {
    harnessContext: _harnessContext,
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

export function compactRecentObservations(observations: ToolObservation[] | undefined): ToolObservation[] | undefined {
  const compacted = (observations ?? [])
    .slice(-LOOP_STATE_LIMITS.toolContextCards)
    .map((observation) => compactToolObservation(observation, LOOP_STATE_LIMITS.toolContextCardChars));
  return compacted.length > 0 ? compacted : undefined;
}

export function compactToolContext(toolContext: ToolContextState | undefined): ToolContextState | undefined {
  const recent = compactRecentObservations(toolContext?.recent);
  const toolCalls = toolContext?.toolCalls;
  if (!recent && !toolCalls) {
    return undefined;
  }
  return {
    recent: recent ?? [],
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function compactToolObservation(observation: ToolObservation, maxChars: number): ToolObservation {
  return {
    ...observation,
    content: compactText(observation.content, maxChars),
  };
}

export function compactWorkingNotes(notes: string[] | undefined): string[] {
  return compactStringList(notes, LOOP_STATE_LIMITS.workingNotes);
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
