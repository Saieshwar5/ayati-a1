import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteTool } from "../../../src/skills/builtins/filesystem/delete.js";
import { clearPendingConfirmationsForTests } from "../../../src/skills/guardrails/confirmation-store.js";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("deleteTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-test-"));
  });

  afterEach(async () => {
    clearPendingConfirmationsForTests();
    await rm(tmp, { recursive: true, force: true });
  });

  it("deletes a file", async () => {
    const file = join(tmp, "remove-me.txt");
    await writeFile(file, "bye", "utf-8");

    const first = await deleteTool.execute({ path: file });
    expect(first.ok).toBe(false);
    expect(first.error).toContain("confirmation required");
    const operationId = String((first.meta as Record<string, unknown>)["operationId"]);

    const result = await deleteTool.execute({ path: file, confirmationToken: `CONFIRM:${operationId}` });
    expect(result.ok).toBe(true);
    expect(await exists(file)).toBe(false);
  });

  it("deletes a directory recursively", async () => {
    const dir = join(tmp, "mydir");
    await mkdir(dir);
    await writeFile(join(dir, "child.txt"), "x", "utf-8");

    const first = await deleteTool.execute({ path: dir, recursive: true });
    expect(first.ok).toBe(false);
    expect(first.error).toContain("confirmation required");
    const operationId = String((first.meta as Record<string, unknown>)["operationId"]);

    const result = await deleteTool.execute({
      path: dir,
      recursive: true,
      confirmationToken: `CONFIRM:${operationId}`,
    });
    expect(result.ok).toBe(true);
    expect(await exists(dir)).toBe(false);
  });

  it("refuses to delete directory without recursive", async () => {
    const dir = join(tmp, "mydir");
    await mkdir(dir);

    const result = await deleteTool.execute({ path: dir });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("recursive");
  });

  it("returns error for non-existent path", async () => {
    const result = await deleteTool.execute({ path: join(tmp, "ghost") });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid input", async () => {
    const result = await deleteTool.execute({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path");
  });
});
