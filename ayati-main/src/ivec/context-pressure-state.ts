import type {
  ContextCompilationMode,
  ContextCompilationReceipt,
} from "../prompt/context-compilation-receipt.js";

export interface ContextPressureState {
  mode: ContextCompilationMode;
  softLimitBreachCount: number;
  admissionRejectionCount: number;
  peakCandidateInputTokens: number;
  lastSoftBreachIteration?: number;
  latestReceipt?: ContextCompilationReceipt;
}

export function createInitialContextPressureState(): ContextPressureState {
  return {
    mode: "full",
    softLimitBreachCount: 0,
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
  const isNewSoftBreach = input.receipt.softLimitExceeded
    && current.lastSoftBreachIteration !== input.iteration;

  return {
    ...current,
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
