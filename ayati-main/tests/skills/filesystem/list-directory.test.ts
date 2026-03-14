import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { listDirectoryTool } from "../../../src/skills/builtins/filesystem/list-directory.js";
import { workspaceRoot } from "../../../src/skills/workspace-paths.js";

describe("listDirectoryTool", () => {
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

  it("lists files and directories", async () => {
    await writeFile(join(tmp, "a.txt"), "a", "utf-8");
    await mkdir(join(tmp, "subdir"));

    const result = await listDirectoryTool.execute({ path: tmp });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[file] a.txt");
    expect(result.output).toContain("[dir] subdir");
  });

  it("lists recursively", async () => {
    await mkdir(join(tmp, "sub"));
    await writeFile(join(tmp, "sub", "deep.txt"), "d", "utf-8");

    const result = await listDirectoryTool.execute({ path: tmp, recursive: true });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("sub/deep.txt");
  });

  it("hides dotfiles by default", async () => {
    await writeFile(join(tmp, ".hidden"), "h", "utf-8");
    await writeFile(join(tmp, "visible.txt"), "v", "utf-8");

    const result = await listDirectoryTool.execute({ path: tmp });
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain(".hidden");
    expect(result.output).toContain("visible.txt");
  });

  it("shows dotfiles with showHidden", async () => {
    await writeFile(join(tmp, ".hidden"), "h", "utf-8");

    const result = await listDirectoryTool.execute({ path: tmp, showHidden: true });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(".hidden");
  });

  it("returns empty directory message", async () => {
    const result = await listDirectoryTool.execute({ path: tmp });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("(empty directory)");
  });

  it("returns error for non-existent path", async () => {
    const result = await listDirectoryTool.execute({ path: join(tmp, "nope") });
    expect(result.ok).toBe(false);
  });

  it("expands tilde path to home directory", async () => {
    const result = await listDirectoryTool.execute({ path: "~" });
    expect(result.ok).toBe(true);
    const meta = result.meta as { dirPath?: string } | undefined;
    expect(meta?.dirPath).toBe(homedir());
  });

  it("lists relative directories from work_space by default", async () => {
    const relativeDir = `vitest-list-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expectedDir = join(workspaceRoot, relativeDir);
    workspaceArtifacts.push(expectedDir);
    await mkdir(expectedDir, { recursive: true });
    await writeFile(join(expectedDir, "inside.txt"), "x", "utf-8");

    const result = await listDirectoryTool.execute({ path: relativeDir });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[file] inside.txt");
  });
});
