import type { PathLike } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({
  calls: 0,
  failOnCall: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: PathLike, newPath: PathLike): Promise<void> => {
      renameControl.calls += 1;
      if (renameControl.calls === renameControl.failOnCall) {
        const error = new Error(
          `simulated rename failure for ${String(newPath)}`,
        ) as NodeJS.ErrnoException;
        error.code = "EBUSY";
        error.path = String(newPath);
        throw error;
      }
      await actual.rename(oldPath, newPath);
    },
  };
});

import { writeFilesTool } from "../../../src/skills/builtins/filesystem/write-files.js";
import { classifyWriteFilesystemError } from "../../../src/skills/builtins/filesystem/write-files-operation.js";
import type { ToolExecutionContext, ToolResult } from "../../../src/skills/types.js";

describe("write_files operation recovery", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "write-files-operation-"));
    renameControl.calls = 0;
    renameControl.failOnCall = 0;
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports a partial commit and safely completes on an identical retry", async () => {
    const first = join(tmp, "first.txt");
    const second = join(tmp, "second.txt");
    const input = {
      files: [
        { path: first, content: "first content" },
        { path: second, content: "second content" },
      ],
    };
    renameControl.failOnCall = 2;

    const partial = await writeFilesTool.execute(input, mutationContext(tmp));

    expect(partial.ok).toBe(false);
    expect(partial.v2?.operationStatus).toBe("partial");
    expect(partial.v2?.code).toBe("WRITE_PARTIAL");
    expect(structured(partial)).toMatchObject({
      filesChanged: 1,
      filesFailed: 1,
      files: [
        { path: first, status: "created" },
        { path: second, status: "failed" },
      ],
    });
    expect(await readFile(first, "utf-8")).toBe("first content");

    renameControl.calls = 0;
    renameControl.failOnCall = 0;
    const retry = await writeFilesTool.execute(input, mutationContext(tmp));

    expect(retry.ok).toBe(true);
    expect(structured(retry)).toMatchObject({
      filesChanged: 1,
      filesUnchanged: 1,
      filesFailed: 0,
      files: [
        { path: first, status: "unchanged" },
        { path: second, status: "created" },
      ],
    });
    expect(await readFile(second, "utf-8")).toBe("second content");
  });

  it.each([
    ["EACCES", "WRITE_PERMISSION_DENIED", "permission", false],
    ["EPERM", "WRITE_PERMISSION_DENIED", "permission", false],
    ["EROFS", "WRITE_READ_ONLY_FILESYSTEM", "permission", false],
    ["ENOSPC", "WRITE_STORAGE_FULL", "transient", true],
    ["EDQUOT", "WRITE_STORAGE_FULL", "transient", true],
    ["ENOENT", "WRITE_PARENT_MISSING", "missing_path", true],
    ["ENOTDIR", "WRITE_INVALID_PATH", "semantic", false],
    ["EMFILE", "WRITE_TEMPORARY_FAILURE", "transient", true],
    ["EBUSY", "WRITE_TEMPORARY_FAILURE", "transient", true],
  ] as const)(
    "maps %s to stable write failure metadata",
    (errnoCode, code, category, retryable) => {
      const error = new Error("simulated") as NodeJS.ErrnoException;
      error.code = errnoCode;
      error.path = "/workspace/site/index.html";

      expect(classifyWriteFilesystemError(error, "/fallback")).toMatchObject({
        errnoCode,
        code,
        category,
        retryable,
        target: "/workspace/site/index.html",
      });
    },
  );
});

function mutationContext(root: string): ToolExecutionContext {
  return {
    resourceScope: {
      kind: "mutation_root",
      rootPath: root,
      authorityPath: root,
      authorityKind: "directory",
    },
  };
}

function structured(result: ToolResult): Record<string, any> {
  return result.v2?.structuredContent as Record<string, any>;
}
