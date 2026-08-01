import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchInFilesTool } from "../../../src/skills/builtins/filesystem/search-in-files.js";
import { workspaceRoot } from "../../../src/skills/workspace-paths.js";

describe("searchInFilesTool", () => {
  let tmp: string;
  let workspaceArtifacts: string[];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-search-test-"));
    workspaceArtifacts = [];
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await Promise.all(workspaceArtifacts.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("returns matching paths without file contents by default", async () => {
    await mkdir(join(tmp, "pkg"));
    await writeFile(join(tmp, "pkg", "a.go"), "private neighbor\n// TODO: add code\n", "utf-8");
    await writeFile(join(tmp, "pkg", "b.txt"), "no match here", "utf-8");

    const result = await searchInFilesTool.execute({
      query: "TODO",
      roots: [tmp],
      maxDepth: 4,
      maxResults: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("a.go");
    expect(result.output).toMatch(/a\.go:2/);
    expect(result.output).not.toContain("TODO: add code");
    expect(result.output).not.toContain("private neighbor");
    expect(result.output).toContain("resultMode=paths");
  });

  it("returns bounded matching text only when snippets are requested", async () => {
    await writeFile(
      join(tmp, "letter.txt"),
      "private neighbor\nAmber Marsh sent the letter\nprivate ending",
      "utf-8",
    );

    const result = await searchInFilesTool.execute({
      query: "Amber Marsh",
      roots: [tmp],
      resultMode: "snippets",
      contextLines: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Amber Marsh sent the letter");
    expect(result.output).toContain("private neighbor");
    expect(result.output).toContain("private ending");
    expect(result.output).toContain("resultMode=snippets");
  });

  it("does not present returned samples as a complete total", async () => {
    await writeFile(
      join(tmp, "repeated.txt"),
      "needle needle\nneedle\nneedle\nneedle\n",
      "utf-8",
    );

    const result = await searchInFilesTool.execute({
      query: "needle",
      roots: [tmp],
      resultMode: "snippets",
    });
    const structured = result.v2?.structuredContent as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(structured["returnedMatchCount"]).toBe(3);
    expect(structured["totalMatchCount"]).toBeNull();
    expect(structured["minimumMatchCount"]).toBe(5);
    expect(structured["countComplete"]).toBe(false);
    expect(structured["hasMore"]).toBe(true);
    expect(structured["capped"]).toBe(false);
    expect(structured).not.toHaveProperty("matchCount");
  });

  it("reports an exhaustive ordinary zero-match search as a complete zero", async () => {
    await writeFile(join(tmp, "handbook.md"), "No access codes are stored here.\n", "utf-8");

    const result = await searchInFilesTool.execute({
      query: "swimming pool access code",
      roots: [tmp],
    });
    const structured = result.v2?.structuredContent as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(structured).toMatchObject({
      resultMode: "paths",
      returnedMatchCount: 0,
      totalMatchCount: 0,
      minimumMatchCount: 0,
      countComplete: true,
      hasMore: false,
      countUnit: "occurrences",
      matches: [],
    });
  });

  it("counts every occurrence without returning matching text", async () => {
    const repeated = Array.from(
      { length: 2_196 },
      (_, index) => `Record ${index + 1}: Routine Greenbridge maintenance cycle`,
    ).join("\n");
    await writeFile(join(tmp, "handbook.md"), repeated, "utf-8");

    const result = await searchInFilesTool.execute({
      query: "Routine Greenbridge maintenance cycle",
      roots: [tmp],
      resultMode: "count",
    });
    const structured = result.v2?.structuredContent as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(structured).toMatchObject({
      resultMode: "count",
      returnedMatchCount: 0,
      totalMatchCount: 2_196,
      minimumMatchCount: 2_196,
      countComplete: true,
      hasMore: false,
      countUnit: "occurrences",
      matches: [],
    });
    expect(result.rawOutput).toBe(
      '2196 occurrences found for "Routine Greenbridge maintenance cycle".',
    );
  });

  it("does not apply the matching-file output limit to count mode", async () => {
    await writeFile(join(tmp, "one.txt"), "needle", "utf-8");
    await writeFile(join(tmp, "two.txt"), "needle needle", "utf-8");

    const result = await searchInFilesTool.execute({
      query: "needle",
      roots: [tmp],
      resultMode: "count",
      maxResults: 1,
    });
    const structured = result.v2?.structuredContent as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(structured).toMatchObject({
      matchedFileCount: 2,
      totalMatchCount: 3,
      countComplete: true,
      capped: false,
    });
  });

  it("does not report an exact total when files are skipped", async () => {
    await writeFile(join(tmp, "large.txt"), `needle\n${"x".repeat(1024 * 1024)}`, "utf-8");

    const result = await searchInFilesTool.execute({
      query: "needle",
      roots: [tmp],
      resultMode: "count",
    });
    const structured = result.v2?.structuredContent as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(structured).toMatchObject({
      returnedMatchCount: 0,
      totalMatchCount: null,
      minimumMatchCount: 0,
      countComplete: false,
      hasMore: true,
      skippedLargeFiles: 1,
    });
    expect(result.output).toContain("no exact total is available");
  });

  it("rejects an unknown result mode", async () => {
    const result = await searchInFilesTool.execute({
      query: "needle",
      roots: [tmp],
      resultMode: "full",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("resultMode");
  });

  it("supports case-insensitive search by default", async () => {
    await writeFile(join(tmp, "caps.txt"), "Error: SOMETHING HAPPENED", "utf-8");

    const result = await searchInFilesTool.execute({
      query: "something happened",
      roots: [tmp],
      maxResults: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("caps.txt");
  });

  it("searches an explicit absolute root", async () => {
    const relativeDir = `vitest-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expectedDir = join(workspaceRoot, relativeDir);
    const filePath = join(expectedDir, "inside.txt");
    workspaceArtifacts.push(expectedDir);
    await mkdir(expectedDir, { recursive: true });
    await writeFile(filePath, "workspace needle", "utf-8");

    const result = await searchInFilesTool.execute({ query: "workspace needle", roots: [expectedDir] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(filePath);
  });
});
