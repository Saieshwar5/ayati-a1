import type { TaskProgressState, TaskStatus } from "../types.js";

interface VerifiedStepProgressInput {
  passed: boolean;
  summary: string;
  evidenceItems: string[];
  newFacts: string[];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function deriveMilestones(step: VerifiedStepProgressInput): string[] {
  const haystack = [...step.evidenceItems, ...step.newFacts].join(" ").toLowerCase();
  if (haystack.includes("write_files") && haystack.includes("written_hashes_match")) {
    return ["write_files completed and read-back hashes verified"];
  }
  return step.summary.trim().length > 0 ? [step.summary] : [];
}

export function reduceVerifiedTaskProgress(
  previous: TaskProgressState,
  step: VerifiedStepProgressInput,
): TaskProgressState {
  const status: TaskStatus = step.passed ? "likely_done" : previous.status;
  const completedMilestones = step.passed
    ? uniqueStrings([...(previous.completedMilestones ?? []), ...deriveMilestones(step)]).slice(0, 6)
    : previous.completedMilestones;

  return {
    status,
    progressSummary: step.summary || previous.progressSummary,
    currentFocus: step.passed
      ? "Confirm whether the goal is fully satisfied."
      : previous.currentFocus,
    completedMilestones,
    openWork: previous.openWork,
    blockers: step.passed ? [] : previous.blockers,
    keyFacts: uniqueStrings([...previous.keyFacts, ...step.newFacts]).slice(0, 8),
    evidence: uniqueStrings([...previous.evidence, ...step.evidenceItems]).slice(0, 6),
    userInputNeeded: status === "needs_user_input" ? previous.userInputNeeded : undefined,
  };
}

