import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { moveTool } from "../../../src/skills/builtins/filesystem/move.js";
import { clearPendingConfirmationsForTests } from "../../../src/skills/guardrails/confirmation-store.js";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("moveTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-test-"));
  });

  afterEach(async () => {
    clearPendingConfirmationsForTests();
    await rm(tmp, { recursive: true, force: true });
  });

  it("moves a file", async () => {
    const src = join(tmp, "a.txt");
    const dest = join(tmp, "b.txt");
    await writeFile(src, "content", "utf-8");

    const result = await moveTool.execute({ source: src, destination: dest });
    expect(result.ok).toBe(true);
    expect(await exists(src)).toBe(false);
    expect(await readFile(dest, "utf-8")).toBe("content");
  });

  it("moves a directory", async () => {
    const srcDir = join(tmp, "srcdir");
    const destDir = join(tmp, "destdir");
    await mkdir(srcDir);
    await writeFile(join(srcDir, "child.txt"), "hi", "utf-8");

    const result = await moveTool.execute({ source: srcDir, destination: destDir });
    expect(result.ok).toBe(true);
    expect(await exists(srcDir)).toBe(false);
    expect(await readFile(join(destDir, "child.txt"), "utf-8")).toBe("hi");
  });

  it("refuses overwrite by default", async () => {
    const src = join(tmp, "src.txt");
    const dest = join(tmp, "dest.txt");
    await writeFile(src, "a", "utf-8");
    await writeFile(dest, "b", "utf-8");

    const result = await moveTool.execute({ source: src, destination: dest });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("overwrite");
  });

  it("overwrites when overwrite=true", async () => {
    const src = join(tmp, "src.txt");
    const dest = join(tmp, "dest.txt");
    await writeFile(src, "new", "utf-8");
    await writeFile(dest, "old", "utf-8");

    const first = await moveTool.execute({ source: src, destination: dest, overwrite: true });
    expect(first.ok).toBe(false);
    expect(first.error).toContain("confirmation required");
    const operationId = String((first.meta as Record<string, unknown>)["operationId"]);

    const result = await moveTool.execute({
      source: src,
      destination: dest,
      overwrite: true,
      confirmationToken: `CONFIRM:${operationId}`,
    });
    expect(result.ok).toBe(true);
    expect(await readFile(dest, "utf-8")).toBe("new");
  });

  it("returns error for non-existent source", async () => {
    const result = await moveTool.execute({
      source: join(tmp, "nope.txt"),
      destination: join(tmp, "dest.txt"),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid input", async () => {
    const result = await moveTool.execute({ source: "a" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("destination");
  });
});
