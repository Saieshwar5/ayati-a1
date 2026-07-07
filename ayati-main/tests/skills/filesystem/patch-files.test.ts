import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchFilesTool } from "../../../src/skills/builtins/filesystem/patch-files.js";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";

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
    await writeFile(html, "<h1>Tea Stall</h1>\n", "utf-8");
    await writeFile(css, "body {\n    background: white;\n}\n", "utf-8");

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
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.code).toBe("FILES_PATCHED");
    expect(result.v2?.structuredContent).toMatchObject({
      filesPatched: 2,
      patchesApplied: 2,
      changesApplied: 2,
    });
    expect(await readFile(html, "utf-8")).toBe("<h1>Evening Tea Stall</h1>\n");
    expect(await readFile(css, "utf-8")).toBe("body {\n    background: #f6f1e7;\n}\n");
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
      filePath: second,
      patchIndex: 0,
      kind: "replace_text",
    });
    expect(await readFile(first, "utf-8")).toBe("alpha beta\n");
    expect(await readFile(second, "utf-8")).toBe("one two\n");
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
      "patched_paths_exist",
      "patched_hashes_match",
    ]);
    expect(result.v2?.verification?.facts.some((fact) => fact.kind === "written_hash_verified")).toBe(true);
  });
});
