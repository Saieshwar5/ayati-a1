import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDirectoryTool,
  executeCreateDirectoryOperation,
} from "../../../src/skills/builtins/filesystem/create-directory.js";
import { workspaceRoot } from "../../../src/skills/workspace-paths.js";
import type { ToolExecutionContext } from "../../../src/skills/types.js";

function mutationContext(rootPath: string): ToolExecutionContext {
  return {
    resourceScope: {
      kind: "mutation_root",
      rootPath,
      authorityPath: rootPath,
      authorityKind: "directory",
    },
  };
}

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
    const result = await createDirectoryTool.execute(
      { path: dir },
      mutationContext(tmp),
    );
    expect(result.ok).toBe(true);

    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
  });

  it("creates nested directories recursively by default", async () => {
    const dir = join(tmp, "a", "b", "c");
    const result = await createDirectoryTool.execute(
      { path: dir },
      mutationContext(tmp),
    );
    expect(result.ok).toBe(true);

    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      status: "created",
      createdPaths: [
        join(tmp, "a"),
        join(tmp, "a", "b"),
        dir,
      ],
    });
  });

  it("succeeds if directory already exists (recursive)", async () => {
    const dir = join(tmp, "existing");
    await createDirectoryTool.execute({ path: dir }, mutationContext(tmp));
    const result = await createDirectoryTool.execute(
      { path: dir },
      mutationContext(tmp),
    );
    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      status: "already_exists",
      createdPaths: [],
    });
  });

  it("fails when recursive=false and parent missing", async () => {
    const dir = join(tmp, "x", "y");
    const result = await createDirectoryTool.execute({
      path: dir,
      recursive: false,
    }, mutationContext(tmp));
    expect(result.ok).toBe(false);
  });

  it("rejects external absolute directories by default", async () => {
    const dir = join(tmp, "blocked");
    const result = await createDirectoryTool.execute({ path: dir });
    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_SELECTED_MUTATION_ROOT");
  });

  it("rejects invalid input", async () => {
    const result = await createDirectoryTool.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path");
  });

  it("reports parent directories created before a later failure", async () => {
    const dir = join(tmp, "partial", "target");
    const result = await executeCreateDirectoryOperation(
      { path: dir },
      mutationContext(tmp),
      {
        async mkdir() {
          await mkdir(join(tmp, "partial"));
          const error = new Error("denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.v2?.operationStatus).toBe("partial");
    expect(result.v2?.code).toBe("CREATE_PARTIAL");
    expect(result.v2?.structuredContent).toMatchObject({
      status: "partial",
      createdPaths: [join(tmp, "partial")],
    });
    await expect(stat(dir)).rejects.toThrow();
  });

  it("rejects stale target state before creation", async () => {
    const dir = join(tmp, "changed");
    await mkdir(dir);
    const result = await createDirectoryTool.execute({ path: dir }, {
      ...mutationContext(tmp),
      filesystemTargetPreconditions: [{
        path: dir,
        expected: { kind: "missing" },
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("CREATE_CONFLICT");
  });

  it("rejects relative directory paths", async () => {
    const relativePath = `vitest-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expectedPath = join(workspaceRoot, relativePath);
    workspaceArtifacts.push(expectedPath);

    const result = await createDirectoryTool.execute({ path: relativePath });
    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("CREATE_INPUT_INVALID");
    await expect(stat(expectedPath)).rejects.toBeDefined();
  });
});
