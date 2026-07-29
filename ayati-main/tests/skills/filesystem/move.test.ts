import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { moveTool } from "../../../src/skills/builtins/filesystem/move.js";
import { executeMoveOperation } from "../../../src/skills/builtins/filesystem/move-operation.js";
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
    await rm(tmp, { recursive: true, force: true });
  });

  it("moves a file", async () => {
    const src = join(tmp, "a.txt");
    const dest = join(tmp, "b.txt");
    await writeFile(src, "content", "utf-8");

    const result = await moveTool.execute({
      source: src,
      destination: dest,
    }, mutationContext(tmp));
    expect(result.ok).toBe(true);
    expect(await exists(src)).toBe(false);
    expect(await readFile(dest, "utf-8")).toBe("content");
  });

  it("moves a directory", async () => {
    const srcDir = join(tmp, "srcdir");
    const destDir = join(tmp, "destdir");
    await mkdir(srcDir);
    await writeFile(join(srcDir, "child.txt"), "hi", "utf-8");

    const result = await moveTool.execute({
      source: srcDir,
      destination: destDir,
    }, mutationContext(tmp));
    expect(result.ok).toBe(true);
    expect(await exists(srcDir)).toBe(false);
    expect(await readFile(join(destDir, "child.txt"), "utf-8")).toBe("hi");
  });

  it("refuses overwrite by default", async () => {
    const src = join(tmp, "src.txt");
    const dest = join(tmp, "dest.txt");
    await writeFile(src, "a", "utf-8");
    await writeFile(dest, "b", "utf-8");

    const result = await moveTool.execute({
      source: src,
      destination: dest,
    }, mutationContext(tmp));
    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("MOVE_DESTINATION_EXISTS");
  });

  it("overwrites when overwrite=true", async () => {
    const src = join(tmp, "src.txt");
    const dest = join(tmp, "dest.txt");
    await writeFile(src, "new", "utf-8");
    await writeFile(dest, "old", "utf-8");

    const result = await moveTool.execute({
      source: src,
      destination: dest,
      overwrite: true,
    }, mutationContext(tmp));
    expect(result.ok).toBe(true);
    expect(await readFile(dest, "utf-8")).toBe("new");
  });

  it("returns error for non-existent source", async () => {
    const result = await moveTool.execute({
      source: join(tmp, "nope.txt"),
      destination: join(tmp, "dest.txt"),
    }, mutationContext(tmp));
    expect(result.ok).toBe(false);
  });

  it("rejects external absolute moves by default", async () => {
    const src = join(tmp, "blocked-src.txt");
    const dest = join(tmp, "blocked-dest.txt");
    await writeFile(src, "content", "utf-8");

    const result = await moveTool.execute({ source: src, destination: dest });
    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_SELECTED_MUTATION_ROOT");
    expect(await exists(src)).toBe(true);
    expect(await exists(dest)).toBe(false);
  });

  it("rejects invalid input", async () => {
    const result = await moveTool.execute({ source: "a" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("destination");
  });

  it("moves a symbolic link without touching its target", async () => {
    const target = join(tmp, "target.txt");
    const source = join(tmp, "source-link");
    const destination = join(tmp, "destination-link");
    await writeFile(target, "value", "utf8");
    await symlink("target.txt", source);

    const result = await moveTool.execute({
      source,
      destination,
    }, mutationContext(tmp));

    expect(result.ok).toBe(true);
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await readlink(destination)).toBe("target.txt");
    expect(await readFile(target, "utf8")).toBe("value");
  });

  it("creates missing destination parents and reports them", async () => {
    const source = join(tmp, "source.txt");
    const destination = join(tmp, "nested", "destination.txt");
    await writeFile(source, "value", "utf8");

    const result = await moveTool.execute({
      source,
      destination,
    }, mutationContext(tmp));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      status: "moved",
      createdParentPaths: [join(tmp, "nested")],
    });
  });

  it("uses verified copy-delete for a simulated cross-device move", async () => {
    const source = join(tmp, "cross-source.txt");
    const destination = join(tmp, "cross-destination.txt");
    await writeFile(source, "cross-device", "utf8");

    const result = await executeMoveOperation({
      source,
      destination,
      overwrite: false,
      createParents: true,
    }, mutationContext(tmp), {
      async rename() {
        const error = new Error("cross device") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      },
      remove: rm,
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      status: "moved",
      strategy: "copy_delete",
    });
    expect(await exists(source)).toBe(false);
    expect(await readFile(destination, "utf8")).toBe("cross-device");
  });

  it("keeps the source and reports the copied destination if source removal fails", async () => {
    const source = join(tmp, "retained-source.txt");
    const destination = join(tmp, "copied-destination.txt");
    await writeFile(source, "retained", "utf8");

    const result = await executeMoveOperation({
      source,
      destination,
      overwrite: false,
      createParents: true,
    }, mutationContext(tmp), {
      async rename() {
        const error = new Error("cross device") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      },
      async remove() {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.operationStatus).toBe("partial");
    expect(result.v2?.code).toBe("MOVE_SOURCE_REMOVE_FAILED");
    expect(result.v2?.structuredContent).toMatchObject({
      status: "copied_but_source_retained",
      moved: false,
    });
    expect(await readFile(source, "utf8")).toBe("retained");
    expect(await readFile(destination, "utf8")).toBe("retained");
  });
});
