import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchFilesTool } from "../../../src/skills/builtins/filesystem/patch-files.js";
import { MAX_PATCH_TARGET_BYTES } from "../../../src/skills/builtins/filesystem/patch-files-operation.js";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";
import type {
  FilesystemTargetState,
  ToolExecutionContext,
} from "../../../src/skills/types.js";

describe("patchFilesTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-patch-files-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("patches multiple files with small stable targets", async () => {
    const html = join(tmp, "index.html");
    const css = join(tmp, "styles.css");
    const js = join(tmp, "script.js");
    await writeFile(html, "<h1>Tea Stall</h1>\n", "utf-8");
    await writeFile(css, "body {\n    background: white;\n}\n", "utf-8");
    await writeFile(js, "const ready = false;\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [
        {
          path: html,
          patches: [{ kind: "replace_text", find: "<h1>Tea Stall</h1>", replace: "<h1>Evening Tea Stall</h1>" }],
        },
        {
          path: css,
          patches: [{ kind: "replace_text", find: "background: white", replace: "background: #f6f1e7" }],
        },
        {
          path: js,
          patches: [{ kind: "replace_text", find: "false", replace: "true" }],
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.code).toBe("FILES_PATCHED");
    expect(result.v2?.structuredContent).toMatchObject({
      filesRequested: 3,
      filesPatched: 3,
      filesFailed: 0,
      patchesApplied: 3,
      changesApplied: 3,
    });
    expect(await readFile(html, "utf-8")).toBe("<h1>Evening Tea Stall</h1>\n");
    expect(await readFile(css, "utf-8")).toBe("body {\n    background: #f6f1e7;\n}\n");
    expect(await readFile(js, "utf-8")).toBe("const ready = true;\n");
  });

  it("rejects more than eight files per patch_files call with split guidance", async () => {
    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: Array.from({ length: 9 }, (_, index) => ({
        path: join(tmp, `${index}.txt`),
        patches: [{
          kind: "replace_text",
          find: "old",
          replace: "new",
        }],
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("at most 8 entries");
    expect(result.error).toContain("split larger patches into multiple patch_files calls");
    expect(result.v2?.code).toBe("PATCH_INPUT_LIMIT_EXCEEDED");
  });

  it("supports replace_all_text, insert, and line replacement", async () => {
    const file = join(tmp, "notes.txt");
    await writeFile(file, "alpha\nbeta beta\ngamma\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [
          { kind: "replace_all_text", find: "beta", replace: "BETA" },
          { kind: "insert_after", anchor: "alpha", content: " inserted" },
          { kind: "replace_lines", startLine: 3, endLine: 3, replace: "delta" },
        ],
      }],
    });

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("alpha inserted\nBETA BETA\ndelta\n");
  });

  it("supports replace_lines through EOF without guessing the final line number", async () => {
    const file = join(tmp, "tail.txt");
    await writeFile(file, "keep\nreplace me\nand me\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_lines",
          startLine: 2,
          endLine: "EOF",
          replace: "new tail",
        }],
      }],
    });

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("keep\nnew tail\n");
    expect(result.v2?.structuredContent).toMatchObject({
      files: [{
        checks: [{
          message: "Exact line replacement through EOF was applied.",
        }],
      }],
    });
  });

  it("uses normalized line counts for replace_lines range failures", async () => {
    const file = join(tmp, "line-count.txt");
    await writeFile(file, "one\ntwo\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_lines",
          startLine: 3,
          endLine: 3,
          replace: "three",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.error?.actual).toMatchObject({ lineCount: 2 });
    expect(await readFile(file, "utf-8")).toBe("one\ntwo\n");
  });

  it("distinguishes a missing file from missing patch text", async () => {
    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: join(tmp, "missing.txt"),
        patches: [{
          kind: "replace_text",
          find: "old",
          replace: "new",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_FILE_NOT_FOUND");
    expect(result.v2?.error?.category).toBe("missing_path");
  });

  it("does not write any file when a later patch fails", async () => {
    const first = join(tmp, "a.txt");
    const second = join(tmp, "b.txt");
    await writeFile(first, "alpha beta\n", "utf-8");
    await writeFile(second, "one two\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [
        { path: first, patches: [{ kind: "replace_text", find: "beta", replace: "gamma" }] },
        { path: second, patches: [{ kind: "replace_text", find: "missing", replace: "three" }] },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_TARGET_NOT_FOUND");
    expect(result.v2?.structuredContent).toMatchObject({
      filesRequested: 2,
      filesPatched: 0,
      filesFailed: 2,
      files: [
        { filePath: first, status: "failed" },
        { filePath: second, status: "failed" },
      ],
    });
    expect(result.v2?.diagnostics).toMatchObject({
      patchIndex: 0,
      patchKind: "replace_text",
    });
    expect(await readFile(first, "utf-8")).toBe("alpha beta\n");
    expect(await readFile(second, "utf-8")).toBe("one two\n");
  });

  it("does not silently apply a whitespace-normalized target", async () => {
    const file = join(tmp, "styles.css");
    await writeFile(file, ".habit-item.done-today {\n  background: var(--success-bg);\n}\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_text",
          find: ".habit-item.done-today { background: var(--success-bg); }",
          replace: ".habit-item.done-today { opacity: 0.7; }",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_TARGET_NOT_FOUND");
    expect(result.v2?.diagnostics).toMatchObject({
      diagnostic: {
        matchStrategy: "whitespace_normalized",
      },
    });
    expect(await readFile(file, "utf-8")).toBe(".habit-item.done-today {\n  background: var(--success-bg);\n}\n");
  });

  it("does not silently apply a trimmed anchor", async () => {
    const file = join(tmp, "script.js");
    await writeFile(file, "function run() {\n    return \"ready\";\n}\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "insert_before",
          anchor: "return \"ready\";  ",
          content: "    console.log(\"starting\");\n",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_TARGET_NOT_FOUND");
    expect(result.v2?.diagnostics).toMatchObject({
      diagnostic: {
        matchStrategy: "whitespace_normalized",
      },
    });
    expect(await readFile(file, "utf-8")).toBe("function run() {\n    return \"ready\";\n}\n");
  });

  it("preserves executable file mode", async () => {
    const file = join(tmp, "run.sh");
    await writeFile(file, "#!/bin/sh\necho old\n", "utf-8");
    await chmod(file, 0o755);

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_text",
          find: "echo old",
          replace: "echo new",
        }],
      }],
    });

    expect(result.ok).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  it("rejects a stale runtime precondition without changing the file", async () => {
    const file = join(tmp, "stale.txt");
    const original = "alpha\n";
    await writeFile(file, original, "utf-8");
    const originalInfo = await stat(file);
    const expected: FilesystemTargetState = {
      kind: "file",
      sizeBytes: Buffer.byteLength(original),
      sha256: createHash("sha256").update(original).digest("hex"),
      mode: originalInfo.mode & 0o777,
      linkCount: originalInfo.nlink,
    };
    await writeFile(file, "alpha external\n", "utf-8");

    const result = await patchFilesTool.execute({
      files: [{
        path: file,
        patches: [{
          kind: "replace_text",
          find: "external",
          replace: "patched",
        }],
      }],
    }, mutationContext(tmp, [{ path: file, expected }]));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_CONFLICT");
    expect(await readFile(file, "utf-8")).toBe("alpha external\n");
  });

  it("rejects duplicate canonical target paths before writing", async () => {
    const file = join(tmp, "duplicate.txt");
    await writeFile(file, "alpha\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [
        {
          path: file,
          patches: [{
            kind: "replace_text",
            find: "alpha",
            replace: "beta",
          }],
        },
        {
          path: join(tmp, ".", "duplicate.txt"),
          patches: [{
            kind: "replace_text",
            find: "alpha",
            replace: "gamma",
          }],
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("DUPLICATE_TARGET_PATH");
    expect(await readFile(file, "utf-8")).toBe("alpha\n");
  });

  it("rejects hard-linked files instead of silently breaking link identity", async () => {
    const file = join(tmp, "linked.txt");
    const sibling = join(tmp, "linked-copy.txt");
    await writeFile(file, "alpha\n", "utf-8");
    await link(file, sibling);

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_text",
          find: "alpha",
          replace: "beta",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_HARDLINK_UNSUPPORTED");
    expect(await readFile(file, "utf-8")).toBe("alpha\n");
    expect(await readFile(sibling, "utf-8")).toBe("alpha\n");
  });

  it("rejects a symbolic-link target without changing its destination", async () => {
    const real = join(tmp, "real.txt");
    const alias = join(tmp, "alias.txt");
    await writeFile(real, "alpha\n", "utf-8");
    await symlink(real, alias);

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: alias,
        patches: [{
          kind: "replace_text",
          find: "alpha",
          replace: "beta",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_TARGET_NOT_REGULAR_FILE");
    expect(await readFile(real, "utf-8")).toBe("alpha\n");
  });

  it("rejects invalid UTF-8 without rewriting the target", async () => {
    const file = join(tmp, "binary.dat");
    const original = Buffer.from([0xff, 0xfe, 0x61]);
    await writeFile(file, original);

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_text",
          find: "a",
          replace: "b",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_INVALID_UTF8");
    expect(await readFile(file)).toEqual(original);
  });

  it("rejects oversized targets before reading their content", async () => {
    const file = join(tmp, "large.txt");
    await writeFile(file, "", "utf-8");
    await truncate(file, MAX_PATCH_TARGET_BYTES + 1);

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_text",
          find: "a",
          replace: "b",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_TARGET_TOO_LARGE");
    expect((await stat(file)).size).toBe(MAX_PATCH_TARGET_BYTES + 1);
  });

  it("does not duplicate an insertion that is already adjacent to its anchor", async () => {
    const file = join(tmp, "insert.txt");
    await writeFile(file, "anchor\n", "utf-8");
    const input = {
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "insert_after",
          anchor: "anchor",
          content: " added",
        }],
      }],
    };

    expect((await patchFilesTool.execute(input)).ok).toBe(true);
    const repeated = await patchFilesTool.execute(input);

    expect(repeated.ok).toBe(false);
    expect(repeated.v2?.code).toBe("PATCH_NO_CHANGE");
    expect(await readFile(file, "utf-8")).toBe("anchor added\n");
    expect(patchFilesTool.annotations).toMatchObject({
      idempotent: false,
      retrySafe: false,
    });
  });

  it("can remove every line without leaving a synthetic newline", async () => {
    const file = join(tmp, "empty.txt");
    await writeFile(file, "remove me\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_lines",
          startLine: 1,
          endLine: "EOF",
          replace: "",
        }],
      }],
    });

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("");
  });

  it("rejects oversized patch text before touching the filesystem", async () => {
    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: join(tmp, "missing.txt"),
        patches: [{
          kind: "replace_text",
          find: "a",
          replace: "x".repeat(256 * 1024),
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_INPUT_LIMIT_EXCEEDED");
  });

  it("rejects unknown patch fields instead of silently ignoring them", async () => {
    const file = join(tmp, "unknown.txt");
    await writeFile(file, "alpha\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_text",
          find: "alpha",
          replace: "beta",
          anchor: "ignored",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_INPUT_INVALID");
    expect(await readFile(file, "utf-8")).toBe("alpha\n");
  });

  it("reports approximate targets as diagnostics without applying them", async () => {
    const file = join(tmp, "diagnostic.txt");
    await writeFile(file, "  stable target\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: file,
        patches: [{
          kind: "replace_text",
          find: "stable   target",
          replace: "changed",
        }],
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.diagnostics).toMatchObject({
      diagnostic: {
        matchStrategy: "whitespace_normalized",
      },
    });
    expect(await readFile(file, "utf-8")).toBe("  stable target\n");
  });

  it("rejects ambiguous single replacements", async () => {
    const file = join(tmp, "index.html");
    await writeFile(file, "<title>Tea Stall</title>\n<h1>Tea Stall</h1>\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{ path: file, patches: [{ kind: "replace_text", find: "Tea Stall", replace: "Evening Tea Stall" }] }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_TARGET_AMBIGUOUS");
    expect(await readFile(file, "utf-8")).toBe("<title>Tea Stall</title>\n<h1>Tea Stall</h1>\n");
  });

  it("rejects no-op patches", async () => {
    const file = join(tmp, "noop.txt");
    await writeFile(file, "same\n", "utf-8");

    const result = await patchFilesTool.execute({
      allowExternalPath: true,
      files: [{ path: file, patches: [{ kind: "replace_text", find: "same", replace: "same" }] }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATCH_NO_CHANGE");
    expect(await readFile(file, "utf-8")).toBe("same\n");
  });

  it("verifies patch contract through the tool executor", async () => {
    const file = join(tmp, "contract.txt");
    await writeFile(file, "alpha beta\n", "utf-8");
    const executor = createToolExecutor([patchFilesTool]);

    const result = await executor.execute("patch_files", {
      allowExternalPath: true,
      files: [{ path: file, patches: [{ kind: "replace_text", find: "beta", replace: "gamma" }] }],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.verification?.status).toBe("passed");
    expect(result.v2?.verification?.assertions.map((assertion) => assertion.id)).toEqual([
      "operation_succeeded",
      "files_result_matches_request",
      "files_requested_matches_request",
    ]);
    expect(result.v2?.verification?.facts.some((fact) => fact.kind === "written_hash_verified")).toBe(false);
  });
});

function mutationContext(
  root: string,
  filesystemTargetPreconditions?: ToolExecutionContext["filesystemTargetPreconditions"],
): ToolExecutionContext {
  return {
    resourceScope: {
      kind: "mutation_root",
      rootPath: root,
      authorityPath: root,
      authorityKind: "directory",
    },
    filesystemTargetPreconditions,
  };
}
