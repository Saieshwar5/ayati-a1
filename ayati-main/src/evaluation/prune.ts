import { readdir, realpath, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { assertContained } from "./storage.js";

export interface EvaluationPruneTarget {
  evaluationId: string;
  path: string;
  modifiedAtMs: number;
  sizeBytes: number;
}

export async function planEvaluationPrune(input: {
  evaluationRoot: string;
  olderThanDays?: number;
  keep?: number;
  nowMs?: number;
}): Promise<EvaluationPruneTarget[]> {
  if (input.olderThanDays === undefined && input.keep === undefined) {
    throw new Error("Prune requires olderThanDays or keep.");
  }
  validateNonNegativeInteger(input.olderThanDays, "olderThanDays");
  validateNonNegativeInteger(input.keep, "keep");
  const root = resolve(input.evaluationRoot);
  const rootReal = await realpath(root).catch(() => root);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = resolve(root, entry.name);
    assertContained(root, path);
    const targetReal = await realpath(path);
    if (!targetReal.startsWith(`${rootReal}${sep}`)) {
      throw new Error(`Unsafe evaluation prune target: ${targetReal}`);
    }
    const metadata = await stat(path);
    return {
      evaluationId: entry.name,
      path,
      modifiedAtMs: metadata.mtimeMs,
      sizeBytes: await directoryBytes(path),
    };
  }));
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  const kept = new Set(
    input.keep !== undefined
      ? candidates.slice(0, input.keep).map((item) => item.evaluationId)
      : [],
  );
  const threshold = input.olderThanDays !== undefined
    ? (input.nowMs ?? Date.now()) - input.olderThanDays * 86_400_000
    : Number.POSITIVE_INFINITY;
  return candidates.filter((item) => !kept.has(item.evaluationId) && item.modifiedAtMs < threshold);
}

export async function executeEvaluationPrune(
  evaluationRoot: string,
  targets: EvaluationPruneTarget[],
): Promise<void> {
  const root = resolve(evaluationRoot);
  const rootReal = await realpath(root);
  for (const target of targets) {
    assertContained(root, target.path);
    const targetReal = await realpath(target.path);
    if (!targetReal.startsWith(`${rootReal}${sep}`) || targetReal === rootReal) {
      throw new Error(`Unsafe evaluation prune target: ${targetReal}`);
    }
    await rm(targetReal, { recursive: true, force: false });
  }
}

function validateNonNegativeInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
}
