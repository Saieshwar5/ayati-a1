import type { WorkState, WorkStatus } from "../types.js";

interface VerifiedStepProgressInput {
  passed: boolean;
  summary: string;
  evidenceItems: string[];
  newFacts: string[];
  artifacts?: string[];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function reduceVerifiedWorkState(
  previous: WorkState,
  step: VerifiedStepProgressInput,
): WorkState {
  const status: WorkStatus = step.passed
    ? previous.status === "done" ? "done" : "not_done"
    : "blocked";
  const summary = step.summary || previous.summary;
  const blockers = step.passed
    ? []
    : uniqueStrings([...(previous.blockers ?? []), step.summary]).slice(0, 4);

  return {
    status,
    summary,
    openWork: previous.openWork,
    blockers,
    verifiedFacts: uniqueStrings([...previous.verifiedFacts, ...step.newFacts]).slice(0, 8),
    evidence: uniqueStrings([...previous.evidence, ...step.evidenceItems]).slice(0, 6),
    artifacts: uniqueStrings([...(previous.artifacts ?? []), ...(step.artifacts ?? [])]).slice(0, 8),
    nextStep: previous.nextStep,
  };
}
