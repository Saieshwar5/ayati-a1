import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFilesTool } from "../../../src/skills/builtins/filesystem/find-files.js";

describe("findFilesTool", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "find-files-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports a conclusive zero-match traversal", async () => {
    await writeFile(join(root, "present.txt"), "present\n", "utf8");

    const result = await findFilesTool.execute({
      query: "missing-report.txt",
      roots: [root],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      query: "missing-report.txt",
      roots: [root],
      matches: [],
      matchCount: 0,
      maxDepth: 10,
      maxResults: 500,
      includeHidden: false,
      capped: false,
      errors: [],
      errorCount: 0,
      depthLimitedDirectoryCount: 0,
      traversalComplete: true,
    });
  });

  it("marks a zero-match search inconclusive when the depth limit skips directories", async () => {
    const levelOne = join(root, "level-one");
    const levelTwo = join(levelOne, "level-two");
    await mkdir(levelTwo, { recursive: true });
    await writeFile(join(levelTwo, "missing-report.txt"), "too deep\n", "utf8");

    const result = await findFilesTool.execute({
      query: "missing-report.txt",
      roots: [root],
      maxDepth: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      matches: [],
      matchCount: 0,
      capped: false,
      errorCount: 0,
      depthLimitedDirectoryCount: 1,
      traversalComplete: false,
    });
  });
});
