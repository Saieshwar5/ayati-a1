import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachFilesystemMutationVerification,
  prepareFilesystemMutationVerification,
  verifyFilesystemMutation,
} from "../../src/app/filesystem-mutation-verifier.js";
import type { ToolResult } from "../../src/skills/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("target-local filesystem mutation verification", () => {
  it("verifies only the declared target without traversing the project", async () => {
    const project = temporaryDirectory();
    const sourceDirectory = join(project, "src");
    const unrelatedDirectory = join(project, "vendor", "deep", "tree");
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(unrelatedDirectory, { recursive: true });
    writeFileSync(
      join(unrelatedDirectory, "large-project-file.bin"),
      "unrelated\n",
      "utf8",
    );
    const target = join(sourceDirectory, "app.ts");
    const content = "export const ready = true;\n";
    const prepared = await prepareFilesystemMutationVerification("write_files", {
      files: [{ path: target, content }],
      createParents: true,
    });

    writeFileSync(target, content, "utf8");
    const verification = await verifyFilesystemMutation(
      prepared!,
      writtenResult(target, content),
    );

    expect(verification).toMatchObject({
      verified: true,
      strategy: "target_local",
      targetCount: 1,
      parentDirectoryCount: 0,
      parentChangedPathCount: 0,
      gitChangedPathCount: 0,
      unexpectedPathCount: 0,
    });
    expect(verification.targets).toEqual([
      expect.objectContaining({
        path: target,
        role: "write",
        before: "missing",
        after: "file",
      }),
    ]);
    expect(JSON.stringify(verification)).not.toContain(
      "large-project-file.bin",
    );
  });

  it("does not attribute an independently changed sibling to the focused tool", async () => {
    const project = temporaryDirectory();
    const target = join(project, "index.html");
    const unrelated = join(project, "unrelated.txt");
    const content = "<h1>Verified</h1>\n";
    const prepared = await prepareFilesystemMutationVerification("write_files", {
      files: [{ path: target, content }],
    });

    writeFileSync(target, content, "utf8");
    writeFileSync(unrelated, "changed independently\n", "utf8");
    const verification = await verifyFilesystemMutation(
      prepared!,
      writtenResult(target, content),
    );

    expect(verification.verified).toBe(true);
    expect(verification.unexpectedPaths).toEqual([]);
  });

  it("turns a successful tool result into failure when its declared target is wrong", async () => {
    const project = temporaryDirectory();
    const target = join(project, "index.html");
    const requested = "<h1>Requested</h1>\n";
    const prepared = await prepareFilesystemMutationVerification("write_files", {
      files: [{ path: target, content: requested }],
    });
    writeFileSync(target, "<h1>Different</h1>\n", "utf8");

    const verification = await verifyFilesystemMutation(
      prepared!,
      writtenResult(target, requested),
    );
    const attached = attachFilesystemMutationVerification(
      writtenResult(target, requested),
      verification,
    );

    expect(verification.verified).toBe(false);
    expect(attached.ok).toBe(false);
    expect(attached.v2?.code).toBe(
      "FILESYSTEM_MUTATION_VERIFICATION_FAILED",
    );
  });

  it("verifies file moves using source and destination state", async () => {
    const project = temporaryDirectory();
    const source = join(project, "before.txt");
    const destination = join(project, "after.txt");
    writeFileSync(source, "move me\n", "utf8");
    const prepared = await prepareFilesystemMutationVerification("move", {
      source,
      destination,
      overwrite: false,
    });

    renameSync(source, destination);
    const verification = await verifyFilesystemMutation(
      prepared!,
      structuredResult("PATH_MOVED", {
        source,
        destination,
        kind: "file",
        status: "moved",
        strategy: "rename",
        createdParentPaths: [],
      }),
    );

    expect(verification.verified).toBe(true);
    expect(verification.targets).toEqual([
      expect.objectContaining({
        path: source,
        role: "move_source",
        before: "file",
        after: "missing",
      }),
      expect.objectContaining({
        path: destination,
        role: "move_destination",
        before: "missing",
        after: "file",
      }),
    ]);
  });

  it("verifies directory creation and deletion from exact state transitions", async () => {
    const project = temporaryDirectory();
    const parent = join(project, "nested");
    const target = join(parent, "site");
    const createPrepared = await prepareFilesystemMutationVerification(
      "create_directory",
      { path: target, recursive: true },
    );
    mkdirSync(target, { recursive: true });
    const created = await verifyFilesystemMutation(
      createPrepared!,
      structuredResult("DIRECTORY_CREATED", {
        dirPath: target,
        status: "created",
        createdPaths: [parent, target],
      }),
    );
    expect(created.verified).toBe(true);

    const deletePrepared = await prepareFilesystemMutationVerification(
      "delete",
      { path: target, recursive: true },
    );
    rmSync(target, { recursive: true });
    const deleted = await verifyFilesystemMutation(
      deletePrepared!,
      structuredResult("PATH_DELETED", {
        targetPath: target,
        kind: "directory",
        status: "deleted",
        deleted: true,
      }),
    );
    expect(deleted.verified).toBe(true);
  });

  it("verifies a copied file and its reported created parent", async () => {
    const project = temporaryDirectory();
    const source = join(project, "source.txt");
    const parent = join(project, "nested");
    const destination = join(parent, "copy.txt");
    writeFileSync(source, "copy\n", "utf8");
    const prepared = await prepareFilesystemMutationVerification("copy", {
      source,
      destination,
    });
    mkdirSync(parent);
    copyFileSync(source, destination);

    const verification = await verifyFilesystemMutation(
      prepared!,
      structuredResult("PATH_COPIED", {
        source,
        destination,
        kind: "file",
        status: "copied",
        createdParentPaths: [parent],
      }),
    );

    expect(verification.verified).toBe(true);
  });

  it("rejects a copy result that reports an unrelated created parent", async () => {
    const project = temporaryDirectory();
    const source = join(project, "source.txt");
    const destination = join(project, "copy.txt");
    const unrelated = join(project, "unrelated");
    writeFileSync(source, "copy\n", "utf8");
    mkdirSync(unrelated);
    const prepared = await prepareFilesystemMutationVerification("copy", {
      source,
      destination,
    });
    copyFileSync(source, destination);

    const verification = await verifyFilesystemMutation(
      prepared!,
      structuredResult("PATH_COPIED", {
        source,
        destination,
        kind: "file",
        status: "copied",
        createdParentPaths: [unrelated],
      }),
    );

    expect(verification.verified).toBe(false);
    expect(verification.problems.join(" ")).toContain(
      "not an ancestor",
    );
  });

  it("verifies permission changes without accepting content or identity changes", async () => {
    const project = temporaryDirectory();
    const target = join(project, "script.sh");
    writeFileSync(target, "#!/bin/sh\n", "utf8");
    chmodSync(target, 0o644);
    const prepared = await prepareFilesystemMutationVerification(
      "set_permissions",
      { files: [{ path: target, mode: "755" }] },
    );
    chmodSync(target, 0o755);

    const verification = await verifyFilesystemMutation(
      prepared!,
      structuredResult("PERMISSIONS_APPLIED", {
        files: [{
          path: target,
          mode: "755",
          status: "changed",
        }],
      }),
    );

    expect(verification.verified).toBe(true);
  });

  it("verifies exact durable effects of partial write and patch results", async () => {
    const project = temporaryDirectory();
    const first = join(project, "first.txt");
    const second = join(project, "second.txt");
    const firstContent = "first\n";
    const secondContent = "second\n";
    const writePrepared = await prepareFilesystemMutationVerification(
      "write_files",
      {
        files: [
          { path: first, content: firstContent },
          { path: second, content: secondContent },
        ],
      },
    );
    writeFileSync(first, firstContent, "utf8");
    const partialWrite = await verifyFilesystemMutation(
      writePrepared!,
      partialFileResult("WRITE_PARTIAL", [
        fileStatus(first, "created", firstContent),
        fileStatus(second, "failed", secondContent),
      ]),
    );
    expect(partialWrite).toMatchObject({
      verified: true,
      toolSucceeded: false,
    });

    writeFileSync(second, "second old\n", "utf8");
    const patchPrepared = await prepareFilesystemMutationVerification(
      "patch_files",
      {
        files: [
          {
            path: first,
            patches: [{
              kind: "replace_text",
              find: "first",
              replace: "updated",
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
      },
    );
    const patchedContent = "updated\n";
    writeFileSync(first, patchedContent, "utf8");
    const partialPatch = await verifyFilesystemMutation(
      patchPrepared!,
      partialFileResult("PATCH_PARTIAL", [
        {
          filePath: first,
          status: "patched",
          sha256: sha256(patchedContent),
        },
        { filePath: second, status: "failed" },
      ]),
    );
    expect(partialPatch).toMatchObject({
      verified: true,
      toolSucceeded: false,
    });
  });

  it("rejects an unreported target change from a failed patch", async () => {
    const project = temporaryDirectory();
    const target = join(project, "target.txt");
    writeFileSync(target, "before\n", "utf8");
    const prepared = await prepareFilesystemMutationVerification("patch_files", {
      files: [{
        path: target,
        patches: [{
          kind: "replace_text",
          find: "before",
          replace: "after",
        }],
      }],
    });
    writeFileSync(target, "after\n", "utf8");

    const verification = await verifyFilesystemMutation(
      prepared!,
      failedResult("PATCH_WRITE_FAILED"),
    );

    expect(verification.verified).toBe(false);
    expect(verification.problems.join(" ")).toContain(
      "changed target state",
    );
  });

  it("rejects a patch that changes executable mode", async () => {
    const project = temporaryDirectory();
    const target = join(project, "run.sh");
    writeFileSync(target, "#!/bin/sh\necho before\n", "utf8");
    chmodSync(target, 0o755);
    const prepared = await prepareFilesystemMutationVerification("patch_files", {
      files: [{
        path: target,
        patches: [{
          kind: "replace_text",
          find: "before",
          replace: "after",
        }],
      }],
    });
    const content = "#!/bin/sh\necho after\n";
    writeFileSync(target, content, "utf8");
    chmodSync(target, 0o644);

    const verification = await verifyFilesystemMutation(
      prepared!,
      structuredResult("FILES_PATCHED", {
        files: [{
          filePath: target,
          status: "patched",
          sha256: sha256(content),
        }],
      }),
    );

    expect(verification.verified).toBe(false);
    expect(verification.problems.join(" ")).toContain("changed file mode");
  });

  it("leaves symbolic-link rejection to the patch tool and verifies no effect", async () => {
    const project = temporaryDirectory();
    const real = join(project, "real.txt");
    const alias = join(project, "alias.txt");
    writeFileSync(real, "alpha\n", "utf8");
    symlinkSync(real, alias, "file");
    const prepared = await prepareFilesystemMutationVerification("patch_files", {
      files: [{
        path: alias,
        patches: [{
          kind: "replace_text",
          find: "alpha",
          replace: "beta",
        }],
      }],
    });

    const verification = await verifyFilesystemMutation(
      prepared!,
      failedResult("PATCH_TARGET_NOT_REGULAR_FILE"),
    );

    expect(verification.verified).toBe(true);
  });

  it("verifies cleanup_pending only when the internal cleanup directory exists", async () => {
    const project = temporaryDirectory();
    const target = join(project, "target");
    const cleanup = join(project, ".ayati-delete-test-target");
    mkdirSync(target);
    const prepared = await prepareFilesystemMutationVerification("delete", {
      path: target,
      recursive: true,
    });
    renameSync(target, cleanup);

    const verification = await verifyFilesystemMutation(
      prepared!,
      structuredResult("DELETE_CLEANUP_PENDING", {
        targetPath: target,
        kind: "directory",
        status: "cleanup_pending",
        deleted: true,
        cleanupPath: cleanup,
      }, false),
    );

    expect(verification.verified).toBe(true);
  });

  it("rejects canonically duplicate targets before mutation preparation", async () => {
    const project = temporaryDirectory();
    const real = join(project, "real");
    const alias = join(project, "alias");
    mkdirSync(real);
    symlinkSync(real, alias, "dir");

    await expect(prepareFilesystemMutationVerification("write_files", {
      files: [
        { path: join(real, "same.txt"), content: "first" },
        { path: join(alias, "same.txt"), content: "second" },
      ],
    })).rejects.toThrow("duplicate canonical target path");
  });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "ayati-target-verification-"));
  temporaryDirectories.push(path);
  return path;
}

function writtenResult(
  path: string,
  content: string,
  status: "created" | "replaced" | "unchanged" = "created",
): ToolResult {
  return structuredResult("FILES_APPLIED", {
    files: [{
      path,
      status,
      sha256: sha256(content),
    }],
  });
}

function partialFileResult(
  code: string,
  files: Array<Record<string, unknown>>,
): ToolResult {
  return {
    ok: false,
    error: "The operation completed partially.",
    v2: {
      transportOk: true,
      operationStatus: "partial",
      code,
      message: "The operation completed partially.",
      structuredContent: { files },
    },
  };
}

function fileStatus(
  path: string,
  status: string,
  content: string,
): Record<string, unknown> {
  return { path, status, sha256: sha256(content) };
}

function failedResult(code: string): ToolResult {
  return {
    ok: false,
    error: "Mutation failed.",
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code,
      message: "Mutation failed.",
    },
  };
}

function structuredResult(
  code: string,
  structuredContent: Record<string, unknown>,
  ok = true,
): ToolResult {
  return {
    ok,
    ...(!ok ? { error: "Mutation is incomplete." } : {}),
    v2: {
      transportOk: true,
      operationStatus: ok ? "succeeded" : "partial",
      code,
      message: "Mutation completed.",
      structuredContent,
    },
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
