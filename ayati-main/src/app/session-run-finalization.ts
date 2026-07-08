import type { AgentLoopResult } from "../ivec/types.js";

type SessionRunStatus = "completed" | "failed" | "blocked" | "needs_user_input";

export interface SessionRunFinalizationFields {
  summary: string;
  intent?: string;
  routing?: string;
  outcome?: string;
  workPerformed: string[];
  verification: string[];
  decisions: string[];
  blockers: string[];
  next?: string;
  changedFiles: string[];
  newFacts: string[];
}

export function buildSessionRunFinalizationFields(
  result: AgentLoopResult,
  status: SessionRunStatus,
): SessionRunFinalizationFields {
  const summary = firstNonEmpty([
    result.workState?.summary,
    result.content,
    "Session run completed.",
  ]);
  const next = firstNonEmpty([
    result.workState?.nextStep,
    result.workState?.userInputNeeded,
    status === "completed" ? "No next step." : undefined,
  ]);
  return {
    summary,
    intent: summary,
    outcome: buildOutcome(status, summary),
    workPerformed: normalizeStrings(
      (result.completedSteps ?? [])
        .filter((step) => step.outcome === "success")
        .map((step) => step.summary),
    ),
    verification: normalizeStrings(
      (result.completedSteps ?? []).flatMap((step) => [
        step.evidenceSummary,
        ...(step.evidenceItems ?? []),
      ]),
    ),
    decisions: [],
    blockers: normalizeStrings(result.workState?.blockers ?? []),
    ...(next ? { next } : {}),
    changedFiles: [],
    newFacts: normalizeStrings([
      ...(result.workState?.verifiedFacts ?? []),
      ...(result.completedSteps ?? []).flatMap((step) => step.newFacts),
    ]),
  };
}

function buildOutcome(status: SessionRunStatus, summary: string): string {
  if (status === "completed") {
    return summary;
  }
  if (status === "failed") {
    return `Run failed: ${summary}`;
  }
  if (status === "blocked") {
    return `Run blocked: ${summary}`;
  }
  return `Needs user input: ${summary}`;
}

function firstNonEmpty(values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
