const MAX_BINDING_CALLS_WITH_CORRECTION = 2;

export interface BindingAttemptPolicyState {
  attempts: number;
  unavailable: boolean;
}

export function createBindingAttemptPolicyState(): BindingAttemptPolicyState {
  return {
    attempts: 0,
    unavailable: false,
  };
}

export function recordBindingAttempt(
  state: BindingAttemptPolicyState,
  attemptConsumed: boolean,
): BindingAttemptPolicyState {
  const attempts = state.attempts + 1;
  return {
    attempts,
    unavailable:
      state.unavailable
      || attemptConsumed
      || attempts >= MAX_BINDING_CALLS_WITH_CORRECTION,
  };
}
