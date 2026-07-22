import { readFile, readdir } from "node:fs/promises";
import type { EvaluationComparison } from "./contracts.js";
import { EvaluationStorage, safeSegment } from "./storage.js";

export async function readEvaluationComparisons(
  storage: EvaluationStorage,
): Promise<EvaluationComparison[]> {
  const names = await readdir(storage.evaluationDirectory).catch(() => []);
  const values = await Promise.all(names
    .filter((name) => name.startsWith("comparison-") && name.endsWith(".json"))
    .map(async (name) => {
      try {
        return JSON.parse(await readFile(storage.path(name), "utf8")) as EvaluationComparison;
      } catch {
        return undefined;
      }
    }));
  return values.filter((value): value is EvaluationComparison => Boolean(value))
    .sort((left, right) => left.generatedAt.localeCompare(right.generatedAt));
}

export function renderEvaluationComparisons(comparisons: EvaluationComparison[]): string[] {
  const rows = comparisons.map((comparison) => [
    comparison.baselineEvaluationId,
    delta(comparison.dimensions.correctness),
    delta(comparison.dimensions.reliability),
    delta(comparison.dimensions.tokenEfficiency),
    delta(comparison.dimensions.latency),
    delta(comparison.dimensions.toolBehavior),
    `[record](comparison-${safeSegment(comparison.baselineEvaluationId)}.json)`,
  ].join(" | "));
  return [
    "## Real-session baseline comparisons",
    "",
    ...(rows.length > 0
      ? [
        "Baseline | Error findings delta | Failed requests delta | Tokens delta | Latency delta ms | Tool calls delta | Evidence",
        "--- | ---: | ---: | ---: | ---: | ---: | ---",
        ...rows,
      ]
      : ["No real-session baseline has been selected for this evaluation."]),
    "",
  ];
}

function delta(value: Record<string, unknown>): string {
  return typeof value["delta"] === "number" ? String(value["delta"]) : "-";
}
