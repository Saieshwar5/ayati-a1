import type {
  ContextCompilationMode,
  ContextCompilationReceipt,
} from "../prompt/context-compilation-receipt.js";

export type ContextPressureEscalationReason =
  | "near_admission_limit"
  | "repeated_unresolved_pressure";

export type ContextPressureRecommendedMode = Exclude<
  ContextCompilationMode,
  "full" | "tool_compact"
>;

export interface ContextPressureState {
  mode: ContextCompilationMode;
  recommendedMode?: ContextPressureRecommendedMode;
  escalationReason?: ContextPressureEscalationReason;
  softLimitBreachCount: number;
  unresolvedPressureStreak: number;
  successfulRecoveryCount: number;
  admissionRejectionCount: number;
  peakCandidateInputTokens: number;
  lastSoftBreachIteration?: number;
  lastRecoveryEvaluationIteration?: number;
  latestReceipt?: ContextCompilationReceipt;
}

const UNRESOLVED_PRESSURE_ESCALATION_COUNT = 2;
const IMMEDIATE_ESCALATION_ADMISSION_RATIO = 0.9;

export function createInitialContextPressureState(): ContextPressureState {
  return {
    mode: "full",
    softLimitBreachCount: 0,
    unresolvedPressureStreak: 0,
    successfulRecoveryCount: 0,
    admissionRejectionCount: 0,
    peakCandidateInputTokens: 0,
  };
}

export function updateContextPressureState(input: {
  current?: ContextPressureState;
  receipt: ContextCompilationReceipt;
  iteration: number;
}): ContextPressureState {
  const current = input.current ?? createInitialContextPressureState();
  const isPrimaryDecision = input.receipt.decisionAttempt === 1;
  const isNewSoftBreach = isPrimaryDecision
    && input.receipt.softLimitExceeded
    && current.lastSoftBreachIteration !== input.iteration;
  const recovery = evaluateRecovery({
    current,
    receipt: input.receipt,
    iteration: input.iteration,
    isPrimaryDecision,
  });

  return {
    ...current,
    mode: laterContextMode(current.mode, input.receipt.mode),
    ...recovery,
    softLimitBreachCount: current.softLimitBreachCount + (isNewSoftBreach ? 1 : 0),
    admissionRejectionCount: current.admissionRejectionCount + (input.receipt.admitted ? 0 : 1),
    peakCandidateInputTokens: Math.max(
      current.peakCandidateInputTokens,
      input.receipt.candidateInputTokens,
    ),
    ...(isNewSoftBreach ? { lastSoftBreachIteration: input.iteration } : {}),
    latestReceipt: input.receipt,
  };
}

function evaluateRecovery(input: {
  current: ContextPressureState;
  receipt: ContextCompilationReceipt;
  iteration: number;
  isPrimaryDecision: boolean;
}): Pick<
  ContextPressureState,
  | "unresolvedPressureStreak"
  | "successfulRecoveryCount"
  | "recommendedMode"
  | "escalationReason"
  | "lastRecoveryEvaluationIteration"
> {
  const unresolvedPressureStreak = input.current.unresolvedPressureStreak ?? 0;
  const successfulRecoveryCount = input.current.successfulRecoveryCount ?? 0;
  const unchanged = {
    unresolvedPressureStreak,
    successfulRecoveryCount,
    ...(input.current.recommendedMode ? { recommendedMode: input.current.recommendedMode } : {}),
    ...(input.current.escalationReason ? { escalationReason: input.current.escalationReason } : {}),
    ...(input.current.lastRecoveryEvaluationIteration !== undefined
      ? { lastRecoveryEvaluationIteration: input.current.lastRecoveryEvaluationIteration }
      : {}),
  };
  const isNewPrimaryEvaluation = input.isPrimaryDecision
    && input.current.lastRecoveryEvaluationIteration !== input.iteration;
  if (isNewPrimaryEvaluation && !input.receipt.softLimitExceeded) {
    return {
      ...unchanged,
      unresolvedPressureStreak: 0,
      lastRecoveryEvaluationIteration: input.iteration,
    };
  }
  const isEnforcedPressureEvaluation = input.receipt.mode === "tool_compact"
    || input.receipt.toolProjectionPolicy === "enforce";
  const shouldEvaluate = isNewPrimaryEvaluation && isEnforcedPressureEvaluation;
  if (!shouldEvaluate) return unchanged;

  if (input.receipt.targetReached === true) {
    return {
      ...unchanged,
      unresolvedPressureStreak: 0,
      successfulRecoveryCount: successfulRecoveryCount + 1,
      lastRecoveryEvaluationIteration: input.iteration,
    };
  }
  if (input.receipt.needsEscalation !== true) {
    return unchanged;
  }

  const nextStreak = unresolvedPressureStreak + 1;
  const nearAdmissionLimit = input.receipt.finalInputTokens
    >= input.receipt.admissionLimitTokens * IMMEDIATE_ESCALATION_ADMISSION_RATIO;
  const shouldRecommendTimeline = nearAdmissionLimit
    || nextStreak >= UNRESOLVED_PRESSURE_ESCALATION_COUNT;
  return {
    ...unchanged,
    unresolvedPressureStreak: nextStreak,
    lastRecoveryEvaluationIteration: input.iteration,
    ...(shouldRecommendTimeline ? {
      recommendedMode: laterRecommendedMode(input.current.recommendedMode, "timeline_checkpoint"),
      escalationReason: nearAdmissionLimit || input.current.escalationReason === "near_admission_limit"
        ? "near_admission_limit"
        : input.current.escalationReason ?? "repeated_unresolved_pressure",
    } : {}),
  };
}

function laterRecommendedMode(
  current: ContextPressureRecommendedMode | undefined,
  observed: ContextPressureRecommendedMode,
): ContextPressureRecommendedMode {
  if (!current) return observed;
  const order: ContextPressureRecommendedMode[] = [
    "timeline_checkpoint",
    "session_digest",
    "step_ledger",
  ];
  return order.indexOf(observed) > order.indexOf(current) ? observed : current;
}

function laterContextMode(
  current: ContextCompilationMode,
  observed: ContextCompilationMode,
): ContextCompilationMode {
  const order: ContextCompilationMode[] = [
    "full",
    "tool_compact",
    "timeline_checkpoint",
    "session_digest",
    "step_ledger",
  ];
  return order.indexOf(observed) > order.indexOf(current) ? observed : current;
}
