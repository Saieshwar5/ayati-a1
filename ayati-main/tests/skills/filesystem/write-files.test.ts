import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFilesTool } from "../../../src/skills/builtins/filesystem/write-files.js";
import { workspaceRoot } from "../../../src/skills/workspace-paths.js";

describe("writeFilesTool", () => {
  let tmp: string;
  let workspaceArtifacts: string[];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-batch-test-"));
    workspaceArtifacts = [];
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await Promise.all(workspaceArtifacts.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("writes multiple files", async () => {
    const first = join(tmp, "a.txt");
    const second = join(tmp, "b.txt");

    const result = await writeFilesTool.execute({
      files: [
        { path: first, content: "alpha" },
        { path: second, content: "beta" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.meta?.filesWritten).toBe(2);
    expect(await readFile(first, "utf-8")).toBe("alpha");
    expect(await readFile(second, "utf-8")).toBe("beta");
  });

  it("creates parent directories when createDirs is true", async () => {
    const first = join(tmp, "nested", "a.txt");
    const second = join(tmp, "nested", "deeper", "b.txt");

    const result = await writeFilesTool.execute({
      createDirs: true,
      files: [
        { path: first, content: "alpha" },
        { path: second, content: "beta" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(await readFile(first, "utf-8")).toBe("alpha");
    expect(await readFile(second, "utf-8")).toBe("beta");
  });

  it("rejects duplicate normalized target paths", async () => {
    const file = join(tmp, "dup.txt");

    const result = await writeFilesTool.execute({
      files: [
        { path: file, content: "first" },
        { path: file, content: "second" },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Duplicate target path");
  });

  it("fails without createDirs when a parent is missing", async () => {
    const result = await writeFilesTool.execute({
      files: [
        { path: join(tmp, "missing", "a.txt"), content: "alpha" },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("writes relative paths inside work_space by default", async () => {
    const relativePath = `vitest-write-files-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const expectedPath = join(workspaceRoot, relativePath);
    workspaceArtifacts.push(expectedPath);

    const result = await writeFilesTool.execute({
      files: [{ path: relativePath, content: "workspace default" }],
    });

    expect(result.ok).toBe(true);
    expect(await readFile(expectedPath, "utf-8")).toBe("workspace default");
  });
});
