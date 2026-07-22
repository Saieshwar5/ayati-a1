import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertContained,
  EvaluationStorage,
  safeSegment,
} from "../../src/evaluation/storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("evaluation storage", () => {
  it("deduplicates content-addressed artifacts and writes indexes atomically", async () => {
    const root = await temporaryRoot();
    const storage = new EvaluationStorage(root, "eval-1", "full");
    await storage.initialize();
    const first = await storage.writeArtifact("request", { b: 2, a: 1 });
    const second = await storage.writeArtifact("request", { a: 1, b: 2 });
    expect(first).toEqual(second);
    expect((await readdir(storage.path("artifacts"))).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    await storage.writeAtomic("session.json", { value: 1 });
    expect(JSON.parse(await readFile(storage.path("session.json"), "utf8"))).toEqual({ value: 1 });
    expect((await readdir(storage.evaluationDirectory)).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("uses restrictive local permissions", async () => {
    const root = await temporaryRoot();
    const storage = new EvaluationStorage(root, "eval-1", "full");
    await storage.initialize();
    await storage.writeAtomic("session.json", { value: 1 });
    expect((await stat(storage.evaluationDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(storage.path("session.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects path traversal and unsafe prune targets", async () => {
    const root = await temporaryRoot();
    expect(() => assertContained(root, resolve(root, "..", "outside"))).toThrow(/escapes/);
    expect(() => safeSegment("../../outside")).toThrow(/Unsafe/);
    expect(() => new EvaluationStorage(root, "..", "full")).toThrow(/Unsafe/);
    expect(() => new EvaluationStorage(root, "RUN:123", "full")).toThrow(/Unsafe evaluation id/);
    expect(safeSegment("RUN:123")).toBe("RUN_123");
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ayati-evaluation-storage-"));
  temporaryDirectories.push(path);
  return path;
}
