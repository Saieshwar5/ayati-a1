import { readFile, readdir } from "node:fs/promises";
import type { EvaluationAnnotation, RunEvidence } from "./contracts.js";
import { EvaluationStorage, safeSegment } from "./storage.js";

export interface RunEvaluationAnnotation {
  runId: string;
  annotation: EvaluationAnnotation;
}

export async function readEvaluationAnnotation(
  storage: EvaluationStorage,
  runId: string,
): Promise<EvaluationAnnotation | undefined> {
  try {
    return JSON.parse(await readFile(
      storage.path("runs", safeSegment(runId), "annotations.json"),
      "utf8",
    )) as EvaluationAnnotation;
  } catch {
    return undefined;
  }
}

export async function readSessionAnnotations(
  storage: EvaluationStorage,
  runs: Pick<RunEvidence, "runId">[],
): Promise<RunEvaluationAnnotation[]> {
  const values = await Promise.all(runs.map(async ({ runId }) => {
    const annotation = await readEvaluationAnnotation(storage, runId);
    return annotation ? { runId, annotation } : undefined;
  }));
  return values.filter((value): value is RunEvaluationAnnotation => Boolean(value));
}

export async function readScenarioLabels(storage: EvaluationStorage): Promise<string[]> {
  const directories = await readdir(storage.path("runs"), { withFileTypes: true }).catch(() => []);
  const labels = await Promise.all(directories.filter((entry) => entry.isDirectory()).map(async (entry) =>
    (await readEvaluationAnnotation(storage, entry.name))?.scenarioLabel));
  return [...new Set(labels.filter((value): value is string => Boolean(value)))];
}

export function renderEvaluationAnnotation(annotation: EvaluationAnnotation): string[] {
  return [
    annotation.scenarioLabel ? `Scenario: ${annotation.scenarioLabel}` : undefined,
    annotation.intendedOutcome ? `Intended outcome: ${annotation.intendedOutcome}` : undefined,
    annotation.observedUsefulness ? `Observed usefulness: ${annotation.observedUsefulness}` : undefined,
    annotation.suspectedIssue ? `Suspected issue: ${annotation.suspectedIssue}` : undefined,
    annotation.userFeedback ? `User feedback: ${annotation.userFeedback}` : undefined,
    annotation.codingAgentConclusions ? `Conclusions: ${annotation.codingAgentConclusions}` : undefined,
    ...(annotation.suggestedExperiments ?? []).map((item) => `- ${item}`),
  ].filter((value): value is string => Boolean(value));
}
