import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findFilesTool } from "../../../src/skills/builtins/filesystem/find-files.js";

describe("findFilesTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-find-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
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
});
