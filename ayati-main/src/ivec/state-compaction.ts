import type { LoopState, PromptToolCallContext, StepSummary, TaskNote, ToolContextState, ToolObservation, WorkState } from "./types.js";

const WORK_STATE_LIMITS = {
  summaryChars: 900,
  nextStepChars: 240,
  userInputNeededChars: 320,
  openWork: { count: 5, chars: 220 },
  blockers: { count: 4, chars: 220 },
  verifiedFacts: { count: 8, chars: 220 },
  evidence: { count: 6, chars: 240 },
  artifacts: { count: 8, chars: 240 },
  taskNotes: { count: 8, textChars: 320, sourceChars: 160 },
};

const LOOP_STATE_LIMITS = {
  workingNotes: { count: 12, chars: 420 },
  toolContextCards: 5,
  toolContextCardChars: 4_000,
  toolCallOutputChars: 4_000,
  toolCallInputStringChars: 1_200,
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
  return {
    status: workState.status,
    summary: compactText(workState.summary, WORK_STATE_LIMITS.summaryChars),
    openWork: compactStringList(workState.openWork, WORK_STATE_LIMITS.openWork),
    blockers: compactStringList(workState.blockers, WORK_STATE_LIMITS.blockers),
    verifiedFacts: compactStringList(workState.verifiedFacts, WORK_STATE_LIMITS.verifiedFacts),
    evidence: compactStringList(workState.evidence, WORK_STATE_LIMITS.evidence),
    artifacts: compactStringList(workState.artifacts, WORK_STATE_LIMITS.artifacts),
    taskNotes: compactTaskNotes(workState.taskNotes, WORK_STATE_LIMITS.taskNotes),
    nextStep: compactOptionalText(workState.nextStep, WORK_STATE_LIMITS.nextStepChars),
    userInputNeeded: compactOptionalText(workState.userInputNeeded, WORK_STATE_LIMITS.userInputNeededChars),
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

function compactUnknown(value: unknown, maxStringChars: number): unknown {
  if (typeof value === "string") {
    return compactText(value, maxStringChars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactUnknown(item, maxStringChars));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = compactUnknown(item, maxStringChars);
  }
  return output;
}

export function compactRecentObservations(observations: ToolObservation[] | undefined): ToolObservation[] | undefined {
  const compacted = (observations ?? [])
    .slice(-LOOP_STATE_LIMITS.toolContextCards)
    .map((observation) => compactToolObservation(observation, LOOP_STATE_LIMITS.toolContextCardChars));
  return compacted.length > 0 ? compacted : undefined;
}

export function compactToolContext(toolContext: ToolContextState | undefined): ToolContextState | undefined {
  const recent = compactRecentObservations(toolContext?.recent);
  const toolCalls = compactPromptToolCalls(toolContext?.toolCalls);
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

function compactPromptToolCalls(calls: PromptToolCallContext[] | undefined): PromptToolCallContext[] | undefined {
  const compacted = (calls ?? [])
    .map((call) => ({
      ...call,
      input: compactUnknown(call.input, LOOP_STATE_LIMITS.toolCallInputStringChars),
      output: compactText(call.output, LOOP_STATE_LIMITS.toolCallOutputChars),
    }));
  return compacted.length > 0 ? compacted : undefined;
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

function compactTaskNotes(
  values: TaskNote[] | undefined,
  limits: { count: number; textChars: number; sourceChars: number },
): TaskNote[] | undefined {
  const byId = new Map<string, TaskNote>();
  for (const note of values ?? []) {
    const id = compactText(note.id, 120);
    const text = compactText(note.text, limits.textChars);
    if (!id || !text) {
      continue;
    }
    byId.set(id, {
      id,
      text,
      source: compactText(note.source, limits.sourceChars),
      expires: note.expires,
    });
  }
  const notes = [...byId.values()].slice(-limits.count);
  return notes.length > 0 ? notes : undefined;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
