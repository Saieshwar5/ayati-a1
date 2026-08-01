import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
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
    expect(result.output).toContain(`[file] ${join(tmp, "a.txt")}`);
    expect(result.output).toContain(`[directory] ${join(tmp, "subdir")}`);
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
    expect(result.output).toContain("0 files");
    expect(result.v2?.structuredContent).toMatchObject({
      dirPath: tmp,
      counts: { files: 0, dirs: 0, symlinks: 0, other: 0 },
      entries: [],
    });
  });

  it("reports symbolic links explicitly and does not recurse through them", async () => {
    const external = await mkdtemp(join(tmpdir(), "list-directory-linked-target-"));
    await writeFile(join(external, "not-traversed.txt"), "outside traversal\n", "utf-8");
    const link = join(tmp, "linked-archive");
    await symlink(external, link);

    const result = await listDirectoryTool.execute({ path: tmp, recursive: true });

    expect(result.ok).toBe(true);
    expect(result.output).toContain(`[symlink] ${link}`);
    expect(result.output).not.toContain("not-traversed.txt");
    expect(result.v2?.structuredContent).toMatchObject({
      counts: { files: 0, dirs: 0, symlinks: 1, other: 0 },
      entries: [{
        name: "linked-archive",
        absolutePath: link,
        kind: "symlink",
        depth: 0,
      }],
    });

    await rm(external, { recursive: true, force: true });
  });

  it("returns error for non-existent path", async () => {
    const result = await listDirectoryTool.execute({ path: join(tmp, "nope") });
    expect(result.ok).toBe(false);
  });

  it("returns actionable feedback when given a regular file", async () => {
    const file = join(tmp, "letter.txt");
    await writeFile(file, "letter content", "utf-8");

    const result = await listDirectoryTool.execute({ path: file });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("NOT_A_DIRECTORY");
    expect(result.error).toContain("this target is a regular file");
    expect(result.error).toContain("Use read_files with the same absolute path");
    expect(result.v2?.structuredContent).toMatchObject({
      requestedPath: file,
      path: file,
      actualKind: "file",
      recommendedTool: "read_files",
    });
  });

  it("rejects tilde aliases", async () => {
    const result = await listDirectoryTool.execute({ path: "~" });
    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("ABSOLUTE_PATH_REQUIRED");
  });

  it("rejects relative directory paths", async () => {
    const relativeDir = `vitest-list-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expectedDir = join(workspaceRoot, relativeDir);
    workspaceArtifacts.push(expectedDir);
    await mkdir(expectedDir, { recursive: true });
    await writeFile(join(expectedDir, "inside.txt"), "x", "utf-8");

    const result = await listDirectoryTool.execute({ path: relativeDir });
    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("ABSOLUTE_PATH_REQUIRED");
  });
});
