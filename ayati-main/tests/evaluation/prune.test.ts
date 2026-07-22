import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeEvaluationPrune,
  planEvaluationPrune,
} from "../../src/evaluation/prune.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("evaluation prune safety", () => {
  it("previews exact contained targets and removes nothing without execution", async () => {
    const root = await fixtureRoot();
    const old = await evaluationDirectory(root, "eval-old", 10);
    await evaluationDirectory(root, "eval-new", 1);
    const targets = await planEvaluationPrune({ evaluationRoot: root, olderThanDays: 5, nowMs: Date.now() });
    expect(targets.map((item) => item.evaluationId)).toEqual(["eval-old"]);
    expect(targets[0]?.path).toBe(old);
    expect(targets[0]?.sizeBytes).toBeGreaterThan(0);
    expect(await planEvaluationPrune({ evaluationRoot: root, keep: 1 })).toHaveLength(1);
  });

  it("deletes only a previously validated confirmed target", async () => {
    const root = await fixtureRoot();
    await evaluationDirectory(root, "eval-old", 10);
    await evaluationDirectory(root, "eval-new", 1);
    const targets = await planEvaluationPrune({ evaluationRoot: root, olderThanDays: 5, nowMs: Date.now() });
    await executeEvaluationPrune(root, targets);
    expect(await planEvaluationPrune({ evaluationRoot: root, keep: 1 })).toHaveLength(0);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ayati-evaluation-prune-"));
  temporaryDirectories.push(root);
  return root;
}

async function evaluationDirectory(root: string, name: string, ageDays: number): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "session.json"), "{}\n");
  const at = new Date(Date.now() - ageDays * 86_400_000);
  await utimes(path, at, at);
  return path;
}
