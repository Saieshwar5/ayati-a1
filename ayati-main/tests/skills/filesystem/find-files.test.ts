import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { findFilesTool } from "../../../src/skills/builtins/filesystem/find-files.js";
import { workspaceRoot } from "../../../src/skills/workspace-paths.js";

describe("findFilesTool", () => {
  let tmp: string;
  let workspaceArtifacts: string[];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-find-test-"));
    workspaceArtifacts = [];
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await Promise.all(workspaceArtifacts.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("finds files by name fragment", async () => {
    await mkdir(join(tmp, "src"));
    await writeFile(join(tmp, "src", "learn1.go"), "package main", "utf-8");
    await writeFile(join(tmp, "src", "other.txt"), "x", "utf-8");

    const result = await findFilesTool.execute({
      query: "learn1.go",
      roots: [tmp],
      maxDepth: 4,
      maxResults: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("learn1.go");
  });

  it("respects maxResults cap", async () => {
    await writeFile(join(tmp, "a.log"), "x", "utf-8");
    await writeFile(join(tmp, "b.log"), "x", "utf-8");
    await writeFile(join(tmp, "c.log"), "x", "utf-8");

    const result = await findFilesTool.execute({
      query: ".log",
      roots: [tmp],
      maxResults: 2,
    });

    expect(result.ok).toBe(true);
    const output = String(result.output ?? "");
    const lines = output.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("continues searching valid roots when one root is missing", async () => {
    await mkdir(join(tmp, "src"));
    await writeFile(join(tmp, "src", "learn1.go"), "package main", "utf-8");

    const result = await findFilesTool.execute({
      query: "learn1.go",
      roots: [join(tmp, "missing-root"), tmp],
      maxDepth: 4,
      maxResults: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("learn1.go");
    const meta = result.meta as { errorCount?: number } | undefined;
    expect(meta?.errorCount).toBeGreaterThan(0);
  });

  it("expands tilde roots to home directory", async () => {
    const result = await findFilesTool.execute({
      query: "definitely-not-present-file-name-ayati",
      roots: ["~"],
      maxDepth: 1,
      maxResults: 5,
    });

    expect(result.ok).toBe(true);
    const meta = result.meta as { roots?: string[] } | undefined;
    expect(meta?.roots?.[0]).toBe(homedir());
  });

  it("returns an error when query uses wildcard syntax", async () => {
    const result = await findFilesTool.execute({ query: "*learn1.go*" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("wildcard");
  });

  it("searches work_space by default when roots are omitted", async () => {
    const relativeDir = `vitest-find-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expectedDir = join(workspaceRoot, relativeDir);
    const filePath = join(expectedDir, "needle.txt");
    workspaceArtifacts.push(expectedDir);
    await mkdir(expectedDir, { recursive: true });
    await writeFile(filePath, "x", "utf-8");

    const result = await findFilesTool.execute({ query: "needle.txt" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(filePath);
  });
});
