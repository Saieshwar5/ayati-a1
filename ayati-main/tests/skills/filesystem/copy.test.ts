import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTool } from "../../../src/skills/builtins/filesystem/copy.js";
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

describe("copyTool", () => {
  let root: string;
  let external: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ayati-copy-"));
    external = await mkdtemp(join(tmpdir(), "ayati-copy-source-"));
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ]);
  });

  it("copies and verifies a regular file while preserving its mode", async () => {
    const source = join(external, "source.txt");
    const destination = join(root, "nested", "copy.txt");
    await writeFile(source, "copy me", "utf8");
    await chmod(source, 0o640);

    const result = await copyTool.execute({
      source,
      destination,
    }, mutationContext(root));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      source,
      destination,
      kind: "file",
      status: "copied",
      createdParentPaths: [join(root, "nested")],
    });
    expect(await readFile(source, "utf8")).toBe("copy me");
    expect(await readFile(destination, "utf8")).toBe("copy me");
    expect((await lstat(destination)).mode & 0o777).toBe(0o640);
  });

  it("copies a directory tree without following symbolic links", async () => {
    const source = join(external, "tree");
    const destination = join(root, "tree-copy");
    await mkdir(source);
    await writeFile(join(source, "value.txt"), "value", "utf8");
    await symlink("value.txt", join(source, "value-link"));

    const result = await copyTool.execute({
      source,
      destination,
    }, mutationContext(root));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      kind: "directory",
      status: "copied",
      entryCount: 3,
    });
    expect(await readFile(join(destination, "value.txt"), "utf8")).toBe("value");
    expect((await lstat(join(destination, "value-link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(destination, "value-link"))).toBe("value.txt");
  });

  it("copies a symbolic link as a symbolic link", async () => {
    const source = join(external, "source-link");
    const destination = join(root, "destination-link");
    await symlink("relative-target.txt", source);

    const result = await copyTool.execute({
      source,
      destination,
    }, mutationContext(root));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      kind: "symlink",
      status: "copied",
    });
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await readlink(destination)).toBe("relative-target.txt");
  });

  it("does not overwrite an existing destination", async () => {
    const source = join(external, "source.txt");
    const destination = join(root, "destination.txt");
    await writeFile(source, "new", "utf8");
    await writeFile(destination, "old", "utf8");

    const result = await copyTool.execute({
      source,
      destination,
    }, mutationContext(root));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("COPY_DESTINATION_EXISTS");
    expect(await readFile(destination, "utf8")).toBe("old");
  });

  it("rejects a destination outside the selected mutation root", async () => {
    const source = join(external, "source.txt");
    const destination = join(external, "destination.txt");
    await writeFile(source, "value", "utf8");

    const result = await copyTool.execute({
      source,
      destination,
    }, mutationContext(root));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_SELECTED_MUTATION_ROOT");
    await expect(lstat(destination)).rejects.toThrow();
  });

  it("rejects copying a directory inside itself", async () => {
    const source = join(root, "tree");
    const destination = join(source, "nested", "copy");
    await mkdir(source);

    const result = await copyTool.execute({
      source,
      destination,
    }, mutationContext(root));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("COPY_INVALID_RELATIONSHIP");
  });
});
