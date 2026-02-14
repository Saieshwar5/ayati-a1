import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchInFilesTool } from "../../../src/skills/builtins/filesystem/search-in-files.js";

describe("searchInFilesTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-search-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
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
});
