import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileTool } from "../../../src/skills/builtins/filesystem/read-file.js";
import { workspaceRoot } from "../../../src/skills/workspace-paths.js";

describe("readFileTool", () => {
  let tmp: string;
  let workspaceArtifacts: string[];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-test-"));
    workspaceArtifacts = [];
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await Promise.all(workspaceArtifacts.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("reads a file successfully", async () => {
    const file = join(tmp, "hello.txt");
    await writeFile(file, "hello\nworld\n", "utf-8");

    const result = await readFileTool.execute({ path: file });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.output).toContain("world");
    expect(result.v2?.structuredContent).toMatchObject({
      filePath: file,
      mode: "auto",
      lineCountKnown: true,
      observation: {
        mode: "focused",
      },
    });
    expect(result.rawOutput).toContain("hello\nworld");
  });

  it("supports slice mode", async () => {
    const file = join(tmp, "lines.txt");
    await writeFile(file, "a\nb\nc\nd\ne\n", "utf-8");

    const result = await readFileTool.execute({ path: file, mode: "slice", startLine: 2, lineCount: 2 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("2: b");
    expect(result.output).toContain("3: c");
    expect(result.v2?.structuredContent).toMatchObject({
      mode: "slice",
      startLine: 2,
      endLine: 3,
    });
  });

  it("supports search mode with focused blocks", async () => {
    const file = join(tmp, "search.txt");
    await writeFile(file, "alpha\nneedle here\nomega\n", "utf-8");

    const result = await readFileTool.execute({ path: file, mode: "search", query: "needle", contextLines: 1 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("needle here");
    expect(result.v2?.structuredContent).toMatchObject({
      mode: "search",
      query: "needle",
      matchCount: 1,
    });
  });

  it("adds a metadata advisory for large explicit full reads", async () => {
    const file = join(tmp, "large.txt");
    await writeFile(file, `${"alpha\n".repeat(15_000)}`, "utf-8");

    const result = await readFileTool.execute({ path: file, mode: "full" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Advisory:");
    expect(result.output).toContain("inspect_paths");
    expect(result.v2?.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "FILE_METADATA_RECOMMENDED",
        severity: "info",
      }),
    ]));
    expect(result.v2?.structuredContent).toMatchObject({
      observation: {
        stats: {
          fileMetadataAdvisory: true,
        },
      },
    });
  });

  it("requires query for search mode", async () => {
    const file = join(tmp, "search-missing-query.txt");
    await writeFile(file, "content", "utf-8");

    const result = await readFileTool.execute({ path: file, mode: "search" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("requires a non-empty query");
  });

  it("returns error for missing file", async () => {
    const result = await readFileTool.execute({ path: join(tmp, "nope.txt") });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error for directory path", async () => {
    const result = await readFileTool.execute({ path: tmp });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Not a file");
  });

  it("rejects invalid input", async () => {
    const result = await readFileTool.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path");
  });

  it("rejects null input", async () => {
    const result = await readFileTool.execute(null);
    expect(result.ok).toBe(false);
  });

  it("reads relative paths from work_space by default", async () => {
    const relativePath = `vitest-read-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const expectedPath = join(workspaceRoot, relativePath);
    workspaceArtifacts.push(expectedPath);
    await writeFile(expectedPath, "workspace read", "utf-8");

    const result = await readFileTool.execute({ path: relativePath });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("workspace read");
  });
});
