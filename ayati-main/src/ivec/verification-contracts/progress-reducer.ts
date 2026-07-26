import type { WorkState } from "../types.js";

interface VerifiedStepProgressInput {
  passed: boolean;
  summary: string;
  evidenceItems: string[];
  newFacts: string[];
  artifacts?: string[];
}

/**
 * Tool verification no longer mutates WorkState. The verified step remains in
 * the run journal and verification index until an explicit WorkState
 * checkpoint selects the small amount of continuity context worth retaining.
 */
export function reduceVerifiedWorkState(
  previous: WorkState,
  _step: VerifiedStepProgressInput,
): WorkState {
  return previous;
}
