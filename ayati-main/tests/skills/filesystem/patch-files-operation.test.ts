import type { PathLike } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

import { patchFilesTool } from "../../../src/skills/builtins/filesystem/patch-files.js";
import { classifyPatchFilesystemError } from "../../../src/skills/builtins/filesystem/patch-files-operation.js";
import type { ToolResult } from "../../../src/skills/types.js";

describe("patch_files operation recovery", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "patch-files-operation-"));
    renameControl.calls = 0;
    renameControl.failOnCall = 0;
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports exact partial effects and leaves no temporary files", async () => {
    const first = join(tmp, "first.txt");
    const second = join(tmp, "second.txt");
    await writeFile(first, "first old\n", "utf-8");
    await writeFile(second, "second old\n", "utf-8");
    renameControl.failOnCall = 2;

    const partial = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [
        {
          path: first,
          patches: [{
            kind: "replace_text",
            find: "old",
            replace: "new",
          }],
        },
        {
          path: second,
          patches: [{
            kind: "replace_text",
            find: "old",
            replace: "new",
          }],
        },
      ],
    });

    expect(partial.ok).toBe(false);
    expect(partial.v2?.operationStatus).toBe("partial");
    expect(partial.v2?.code).toBe("PATCH_PARTIAL");
    expect(partial.v2?.error?.retryable).toBe(false);
    expect(structured(partial)).toMatchObject({
      filesRequested: 2,
      filesPatched: 1,
      filesFailed: 1,
      files: [
        { filePath: first, status: "patched" },
        { filePath: second, status: "failed" },
      ],
    });
    expect(await readFile(first, "utf-8")).toBe("first new\n");
    expect(await readFile(second, "utf-8")).toBe("second old\n");
    expect((await readdir(tmp)).some((name) => name.startsWith(".ayati-patch-")))
      .toBe(false);

    renameControl.calls = 0;
    renameControl.failOnCall = 0;
    const remaining = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: second,
        patches: [{
          kind: "replace_text",
          find: "old",
          replace: "new",
        }],
      }],
    });
    expect(remaining.ok).toBe(true);
    expect(await readFile(second, "utf-8")).toBe("second new\n");
  });

  it.each([
    ["EACCES", "PATCH_PERMISSION_DENIED", "permission", false],
    ["EPERM", "PATCH_PERMISSION_DENIED", "permission", false],
    ["EROFS", "PATCH_READ_ONLY_FILESYSTEM", "permission", false],
    ["ENOSPC", "PATCH_STORAGE_FULL", "transient", true],
    ["EDQUOT", "PATCH_STORAGE_FULL", "transient", true],
    ["ENOENT", "PATCH_FILE_NOT_FOUND", "missing_path", true],
    ["ENOTDIR", "PATCH_INVALID_PATH", "semantic", false],
    ["EMFILE", "PATCH_TEMPORARY_FAILURE", "transient", true],
    ["EBUSY", "PATCH_TEMPORARY_FAILURE", "transient", true],
  ] as const)(
    "maps %s to stable patch failure metadata",
    (errnoCode, code, category, retryable) => {
      const error = new Error("simulated") as NodeJS.ErrnoException;
      error.code = errnoCode;
      error.path = "/workspace/site/index.html";

      expect(classifyPatchFilesystemError(error, "/fallback")).toMatchObject({
        errnoCode,
        code,
        category,
        retryable,
        target: "/workspace/site/index.html",
      });
    },
  );
});

function structured(result: ToolResult): Record<string, any> {
  return result.v2?.structuredContent as Record<string, any>;
}
