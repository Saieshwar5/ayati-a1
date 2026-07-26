import type { ImportantContextItem, WorkState } from "./contracts.js";

export function workStateOpenTasks(workState: WorkState): string[] {
  return workState.plan
    .filter((item) => item.status !== "done")
    .map((item) => item.task);
}

export function workStateBlockers(workState: WorkState): string[] {
  return unique([
    ...workState.plan
      .filter((item) => item.status === "blocked")
      .map((item) => item.task),
    ...workState.importantContext
      .filter((item) => item.kind === "constraint")
      .map((item) => item.value),
  ]);
}

export function workStateFindings(workState: WorkState): string[] {
  return contextValues(workState, ["finding", "decision"]);
}

export function workStateEvidenceRefs(workState: WorkState): string[] {
  return unique(
    workState.importantContext
      .map((item) => item.ref)
      .filter((ref): ref is string => Boolean(ref?.trim())),
  );
}

export function workStateArtifacts(workState: WorkState): string[] {
  return unique(
    workState.importantContext
      .filter((item) => item.kind === "artifact")
      .map((item) => item.ref ?? item.value),
  );
}

export function hasMaterialWorkState(workState: WorkState): boolean {
  return (
    workState.summary.trim().length > 0
    && workState.summary.trim() !== "Run started."
  )
    || workState.plan.length > 0
    || workState.importantContext.length > 0
    || Boolean(workState.nextAction?.trim())
    || workState.status !== "in_progress";
}

function contextValues(
  workState: WorkState,
  kinds: ImportantContextItem["kind"][],
): string[] {
  const accepted = new Set(kinds);
  return unique(
    workState.importantContext
      .filter((item) => accepted.has(item.kind))
      .map((item) => item.value),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
