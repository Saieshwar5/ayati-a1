import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileTool } from "../../../src/skills/builtins/filesystem/read-file.js";

describe("readFileTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads a file successfully", async () => {
    const file = join(tmp, "hello.txt");
    await writeFile(file, "hello\nworld\n", "utf-8");

    const result = await readFileTool.execute({ path: file });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.output).toContain("world");
  });

  it("supports offset and limit", async () => {
    const file = join(tmp, "lines.txt");
    await writeFile(file, "a\nb\nc\nd\ne\n", "utf-8");

    const result = await readFileTool.execute({ path: file, offset: 1, limit: 2 });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("b\nc");
  });

  it("returns error for missing file", async () => {
    const result = await readFileTool.execute({ path: join(tmp, "nope.txt") });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error for directory path", async () => {
    const result = await readFileTool.execute({ path: tmp });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Not a file");
  });

  it("rejects invalid input", async () => {
    const result = await readFileTool.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path");
  });

  it("rejects null input", async () => {
    const result = await readFileTool.execute(null);
    expect(result.ok).toBe(false);
  });
});
