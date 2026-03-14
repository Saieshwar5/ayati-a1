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

  it("finds text matches inside files", async () => {
    await mkdir(join(tmp, "pkg"));
    await writeFile(join(tmp, "pkg", "a.go"), "package main\n// TODO: add code\n", "utf-8");
    await writeFile(join(tmp, "pkg", "b.txt"), "no match here", "utf-8");

    const result = await searchInFilesTool.execute({
      query: "TODO",
      roots: [tmp],
      maxDepth: 4,
      maxResults: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("a.go");
    expect(result.output).toContain("TODO");
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

  it("searches work_space by default when roots are omitted", async () => {
    const relativeDir = `vitest-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expectedDir = join(workspaceRoot, relativeDir);
    const filePath = join(expectedDir, "inside.txt");
    workspaceArtifacts.push(expectedDir);
    await mkdir(expectedDir, { recursive: true });
    await writeFile(filePath, "workspace needle", "utf-8");

    const result = await searchInFilesTool.execute({ query: "workspace needle" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(filePath);
  });
});
