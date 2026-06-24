import type { TaskNote, WorkState, WorkStatus } from "../types.js";

interface VerifiedStepProgressInput {
  passed: boolean;
  summary: string;
  evidenceItems: string[];
  newFacts: string[];
  taskNotes?: TaskNote[];
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
    taskNotes: mergeTaskNotes(previous.taskNotes, step.taskNotes),
    nextStep: previous.nextStep,
  };
}

function mergeTaskNotes(previous: TaskNote[] | undefined, next: TaskNote[] | undefined): TaskNote[] | undefined {
  const byId = new Map<string, TaskNote>();
  for (const note of previous ?? []) {
    if (note.expires === "task" && note.id.trim().length > 0 && note.text.trim().length > 0) {
      byId.set(note.id, normalizeNote(note));
    }
  }
  for (const note of next ?? []) {
    if (note.id.trim().length > 0 && note.text.trim().length > 0) {
      byId.set(note.id, normalizeNote(note));
    }
  }
  const notes = [...byId.values()].slice(-8);
  return notes.length > 0 ? notes : undefined;
}

function normalizeNote(note: TaskNote): TaskNote {
  return {
    id: note.id.trim(),
    text: note.text.replace(/\s+/g, " ").trim(),
    source: note.source.replace(/\s+/g, " ").trim(),
    expires: note.expires,
  };
}
