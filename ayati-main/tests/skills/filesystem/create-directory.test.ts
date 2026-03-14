import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDirectoryTool } from "../../../src/skills/builtins/filesystem/create-directory.js";
import { workspaceRoot } from "../../../src/skills/workspace-paths.js";

describe("createDirectoryTool", () => {
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

  it("creates a directory", async () => {
    const dir = join(tmp, "newdir");
    const result = await createDirectoryTool.execute({ path: dir });
    expect(result.ok).toBe(true);

    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
  });

  it("creates nested directories recursively by default", async () => {
    const dir = join(tmp, "a", "b", "c");
    const result = await createDirectoryTool.execute({ path: dir });
    expect(result.ok).toBe(true);

    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
  });

  it("succeeds if directory already exists (recursive)", async () => {
    const dir = join(tmp, "existing");
    await createDirectoryTool.execute({ path: dir });
    const result = await createDirectoryTool.execute({ path: dir });
    expect(result.ok).toBe(true);
  });

  it("fails when recursive=false and parent missing", async () => {
    const dir = join(tmp, "x", "y");
    const result = await createDirectoryTool.execute({ path: dir, recursive: false });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid input", async () => {
    const result = await createDirectoryTool.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path");
  });

  it("creates relative directories inside work_space by default", async () => {
    const relativePath = `vitest-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expectedPath = join(workspaceRoot, relativePath);
    workspaceArtifacts.push(expectedPath);

    const result = await createDirectoryTool.execute({ path: relativePath });
    expect(result.ok).toBe(true);

    const info = await stat(expectedPath);
    expect(info.isDirectory()).toBe(true);
  });
});
