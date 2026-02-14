import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editFileTool } from "../../../src/skills/builtins/filesystem/edit-file.js";

describe("editFileTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("replaces first occurrence by default", async () => {
    const file = join(tmp, "doc.txt");
    await writeFile(file, "foo bar foo baz", "utf-8");

    const result = await editFileTool.execute({ path: file, oldString: "foo", newString: "qux" });
    expect(result.ok).toBe(true);
    expect(result.meta?.replacements).toBe(1);

    const content = await readFile(file, "utf-8");
    expect(content).toBe("qux bar foo baz");
  });

  it("replaces all occurrences with replaceAll", async () => {
    const file = join(tmp, "doc.txt");
    await writeFile(file, "foo bar foo baz foo", "utf-8");

    const result = await editFileTool.execute({
      path: file,
      oldString: "foo",
      newString: "qux",
      replaceAll: true,
    });
    expect(result.ok).toBe(true);
    expect(result.meta?.replacements).toBe(3);

    const content = await readFile(file, "utf-8");
    expect(content).toBe("qux bar qux baz qux");
  });

  it("returns error when oldString not found", async () => {
    const file = join(tmp, "doc.txt");
    await writeFile(file, "hello world", "utf-8");

    const result = await editFileTool.execute({ path: file, oldString: "xyz", newString: "abc" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error for missing file", async () => {
    const result = await editFileTool.execute({
      path: join(tmp, "nope.txt"),
      oldString: "a",
      newString: "b",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects empty oldString", async () => {
    const result = await editFileTool.execute({
      path: join(tmp, "a.txt"),
      oldString: "",
      newString: "b",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("oldString");
  });
});
