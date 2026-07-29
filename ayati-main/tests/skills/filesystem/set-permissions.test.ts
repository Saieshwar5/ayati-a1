import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeSetPermissionsOperation,
  setPermissionsTool,
} from "../../../src/skills/builtins/filesystem/set-permissions.js";
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

describe("setPermissionsTool", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ayati-permissions-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sets exact permissions without changing content or file identity", async () => {
    const path = join(root, "script.sh");
    await writeFile(path, "#!/bin/sh\n", "utf8");
    await chmod(path, 0o644);
    const before = await lstat(path);

    const result = await setPermissionsTool.execute({
      files: [{ path, mode: "755" }],
    }, mutationContext(root));

    const after = await lstat(path);
    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      filesRequested: 1,
      filesChanged: 1,
      files: [{ path, mode: "755", status: "changed" }],
    });
    expect(after.mode & 0o777).toBe(0o755);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\n");
    expect(result.v2?.artifacts).toEqual([]);
  });

  it("reports an already-current mode without changing the file", async () => {
    const path = join(root, "current.txt");
    await writeFile(path, "value", "utf8");
    await chmod(path, 0o640);

    const result = await setPermissionsTool.execute({
      files: [{ path, mode: "640" }],
    }, mutationContext(root));

    expect(result.ok).toBe(true);
    expect(result.v2?.code).toBe("PERMISSIONS_ALREADY_CURRENT");
    expect(result.v2?.structuredContent).toMatchObject({
      filesChanged: 0,
      filesUnchanged: 1,
      files: [{ status: "unchanged", mode: "640" }],
    });
  });

  it("reports exact partial progress if a later chmod fails", async () => {
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    await writeFile(first, "first", "utf8");
    await writeFile(second, "second", "utf8");
    await chmod(first, 0o600);
    await chmod(second, 0o600);

    const result = await executeSetPermissionsOperation({
      files: [
        { path: first, mode: "640" },
        { path: second, mode: "640" },
      ],
    }, mutationContext(root), {
      async chmod(path, mode) {
        if (path === second) {
          const error = new Error("denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        await chmod(path, mode);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.operationStatus).toBe("partial");
    expect(result.v2?.code).toBe("PERMISSIONS_PARTIAL");
    expect(result.v2?.structuredContent).toMatchObject({
      filesRequested: 2,
      filesChanged: 1,
      filesFailed: 1,
      files: [
        { path: first, status: "changed", mode: "640" },
        { path: second, status: "failed", mode: "600" },
      ],
    });
    expect((await lstat(first)).mode & 0o777).toBe(0o640);
    expect((await lstat(second)).mode & 0o777).toBe(0o600);
  });

  it("rejects symbolic links and multiply linked files", async () => {
    const source = join(root, "source.txt");
    const alias = join(root, "alias.txt");
    const hardlink = join(root, "hardlink.txt");
    await writeFile(source, "value", "utf8");
    await symlink(source, alias);

    const symlinkResult = await setPermissionsTool.execute({
      files: [{ path: alias, mode: "600" }],
    }, mutationContext(root));
    expect(symlinkResult.ok).toBe(false);
    expect(symlinkResult.v2?.code).toBe(
      "PERMISSIONS_TARGET_NOT_REGULAR_FILE",
    );

    await link(source, hardlink);
    const hardlinkResult = await setPermissionsTool.execute({
      files: [{ path: source, mode: "600" }],
    }, mutationContext(root));
    expect(hardlinkResult.ok).toBe(false);
    expect(hardlinkResult.v2?.code).toBe("PERMISSIONS_HARDLINK_UNSUPPORTED");
  });

  it("rejects unsafe or malformed modes", async () => {
    const path = join(root, "value.txt");
    await writeFile(path, "value", "utf8");

    for (const mode of ["000", "888", "4755", "u+x"]) {
      const result = await setPermissionsTool.execute({
        files: [{ path, mode }],
      }, mutationContext(root));
      expect(result.ok).toBe(false);
      expect(result.v2?.code).toBe("PERMISSIONS_INPUT_INVALID");
    }
  });
});
