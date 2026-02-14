import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileTool } from "../../../src/skills/builtins/filesystem/write-file.js";

describe("writeFileTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes a file", async () => {
    const file = join(tmp, "out.txt");
    const result = await writeFileTool.execute({ path: file, content: "hello world" });
    expect(result.ok).toBe(true);

    const content = await readFile(file, "utf-8");
    expect(content).toBe("hello world");
  });

  it("overwrites an existing file", async () => {
    const file = join(tmp, "out.txt");
    await writeFileTool.execute({ path: file, content: "first" });
    await writeFileTool.execute({ path: file, content: "second" });

    const content = await readFile(file, "utf-8");
    expect(content).toBe("second");
  });

  it("creates parent directories with createDirs", async () => {
    const file = join(tmp, "a", "b", "c.txt");
    const result = await writeFileTool.execute({ path: file, content: "deep", createDirs: true });
    expect(result.ok).toBe(true);

    const content = await readFile(file, "utf-8");
    expect(content).toBe("deep");
  });

  it("fails without createDirs when parent missing", async () => {
    const file = join(tmp, "x", "y.txt");
    const result = await writeFileTool.execute({ path: file, content: "nope" });
    expect(result.ok).toBe(false);
  });

  it("rejects missing content", async () => {
    const result = await writeFileTool.execute({ path: join(tmp, "a.txt") });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("content");
  });
});
