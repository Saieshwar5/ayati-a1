import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editFilesTool } from "../../../src/skills/builtins/filesystem/edit-files.js";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";

describe("editFilesTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-batch-edit-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("applies edits across multiple files as one batch", async () => {
    const first = join(tmp, "a.txt");
    const second = join(tmp, "b.txt");
    await writeFile(first, "alpha beta\n", "utf-8");
    await writeFile(second, "one two one\n", "utf-8");

    const result = await editFilesTool.execute({
      allowExternalPath: true,
      edits: [
        { path: first, oldString: "beta", newString: "gamma" },
        { path: second, oldString: "one", newString: "three", replaceAll: true },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.code).toBe("FILES_EDITED");
    expect(result.v2?.structuredContent).toMatchObject({
      filesEdited: 2,
      editsApplied: 2,
      changesApplied: 3,
      files: [
        { requestedPath: first, filePath: first, editsApplied: 1, changesApplied: 1 },
        { requestedPath: second, filePath: second, editsApplied: 1, changesApplied: 2 },
      ],
    });
    expect(await readFile(first, "utf-8")).toBe("alpha gamma\n");
    expect(await readFile(second, "utf-8")).toBe("three two three\n");
  });

  it("applies same-file edits in request order", async () => {
    const file = join(tmp, "ordered.txt");
    await writeFile(file, "const name = \"old\";\nconsole.log(name);\n", "utf-8");

    const result = await editFilesTool.execute({
      allowExternalPath: true,
      edits: [
        { path: file, oldString: "\"old\"", newString: "\"new\"" },
        { path: file, mode: "insert_after", anchor: "console.log(name);", content: "\nconsole.log(\"done\");" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.meta?.filesEdited).toBe(1);
    expect(result.meta?.editsApplied).toBe(2);
    expect(await readFile(file, "utf-8")).toBe("const name = \"new\";\nconsole.log(name);\nconsole.log(\"done\");\n");
  });

  it("supports 1-based line range replacement", async () => {
    const file = join(tmp, "range.txt");
    await writeFile(file, "one\ntwo\nthree\nfour\n", "utf-8");

    const result = await editFilesTool.execute({
      allowExternalPath: true,
      edits: [
        { path: file, mode: "replace_range", startLine: 2, endLine: 3, newString: "TWO\nTHREE" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("one\nTWO\nTHREE\nfour\n");
  });

  it("does not write any file when a later edit precondition fails", async () => {
    const first = join(tmp, "a.txt");
    const second = join(tmp, "b.txt");
    await writeFile(first, "alpha beta\n", "utf-8");
    await writeFile(second, "one two\n", "utf-8");

    const result = await editFilesTool.execute({
      allowExternalPath: true,
      edits: [
        { path: first, oldString: "beta", newString: "gamma" },
        { path: second, oldString: "missing", newString: "three" },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("EDIT_PRECONDITION_FAILED");
    expect(result.v2?.structuredContent).toMatchObject({
      failedEditIndex: 1,
      filePath: second,
      mode: "replace",
    });
    expect(await readFile(first, "utf-8")).toBe("alpha beta\n");
    expect(await readFile(second, "utf-8")).toBe("one two\n");
  });

  it("rejects external absolute edits by default", async () => {
    const file = join(tmp, "blocked.txt");
    await writeFile(file, "hello", "utf-8");

    const result = await editFilesTool.execute({
      edits: [{ path: file, oldString: "hello", newString: "bye" }],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("EXTERNAL_WORKSPACE_PATH_REQUIRES_ALLOW");
  });

  it("verifies edit contract through the tool executor", async () => {
    const first = join(tmp, "contract-a.txt");
    const second = join(tmp, "contract-b.txt");
    await writeFile(first, "alpha beta", "utf-8");
    await writeFile(second, "one two", "utf-8");
    const executor = createToolExecutor([editFilesTool]);

    const result = await executor.execute("edit_files", {
      allowExternalPath: true,
      edits: [
        { path: first, oldString: "beta", newString: "gamma" },
        { path: second, oldString: "two", newString: "three" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.verification?.status).toBe("passed");
    expect(result.v2?.verification?.assertions.map((assertion) => assertion.id)).toEqual([
      "operation_succeeded",
      "edited_paths_exist",
      "edited_hashes_match",
    ]);
    expect(result.v2?.verification?.facts.some((fact) => fact.kind === "written_hash_verified")).toBe(true);
    expect(result.v2?.artifacts?.map((artifact) => artifact.path)).toEqual([first, second]);
  });
});
