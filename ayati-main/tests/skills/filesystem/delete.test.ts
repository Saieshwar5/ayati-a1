import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteTool } from "../../../src/skills/builtins/filesystem/delete.js";
import { executeDeleteOperation } from "../../../src/skills/builtins/filesystem/delete.js";
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

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("deleteTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("deletes a file", async () => {
    const file = join(tmp, "remove-me.txt");
    await writeFile(file, "bye", "utf-8");

    const result = await deleteTool.execute(
      { path: file },
      mutationContext(tmp),
    );
    expect(result.ok).toBe(true);
    expect(await exists(file)).toBe(false);
  });

  it("deletes a directory recursively", async () => {
    const dir = join(tmp, "mydir");
    await mkdir(dir);
    await writeFile(join(dir, "child.txt"), "x", "utf-8");

    const result = await deleteTool.execute(
      { path: dir, recursive: true },
      mutationContext(tmp),
    );
    expect(result.ok).toBe(true);
    expect(await exists(dir)).toBe(false);
  });

  it("refuses to delete directory without recursive", async () => {
    const dir = join(tmp, "mydir");
    await mkdir(dir);

    const result = await deleteTool.execute(
      { path: dir },
      mutationContext(tmp),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("recursive");
  });

  it("succeeds unchanged for an already-absent path", async () => {
    const result = await deleteTool.execute(
      { path: join(tmp, "ghost") },
      mutationContext(tmp),
    );
    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      status: "already_absent",
      deleted: false,
    });
  });

  it("rejects external absolute deletes by default", async () => {
    const file = join(tmp, "blocked.txt");
    await writeFile(file, "bye", "utf-8");

    const result = await deleteTool.execute({ path: file });
    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_SELECTED_MUTATION_ROOT");
    expect(await exists(file)).toBe(true);
  });

  it("rejects invalid input", async () => {
    const result = await deleteTool.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path");
  });

  it("unlinks a symbolic link without deleting its target", async () => {
    const target = join(tmp, "target.txt");
    const alias = join(tmp, "alias.txt");
    await writeFile(target, "keep", "utf8");
    await symlink(target, alias);

    const result = await deleteTool.execute(
      { path: alias },
      mutationContext(tmp),
    );

    expect(result.ok).toBe(true);
    expect(await exists(alias)).toBe(false);
    expect(await readFile(target, "utf8")).toBe("keep");
  });

  it("reports cleanup_pending after atomically removing the requested directory", async () => {
    const dir = join(tmp, "cleanup");
    await mkdir(dir);
    await writeFile(join(dir, "value.txt"), "value", "utf8");

    const result = await executeDeleteOperation(
      { path: dir, recursive: true },
      mutationContext(tmp),
      {
        rename,
        unlink,
        async remove() {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.v2?.operationStatus).toBe("partial");
    expect(result.v2?.code).toBe("DELETE_CLEANUP_PENDING");
    expect(result.v2?.structuredContent).toMatchObject({
      status: "cleanup_pending",
      deleted: true,
    });
    expect(await exists(dir)).toBe(false);
    const cleanupPath = String(
      (result.v2?.structuredContent as Record<string, unknown>)["cleanupPath"],
    );
    expect((await lstat(cleanupPath)).isDirectory()).toBe(true);
    await rm(cleanupPath, { recursive: true, force: true });
  });
});
