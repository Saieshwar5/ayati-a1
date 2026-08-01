import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFilesTool } from "../../../src/skills/builtins/filesystem/find-files.js";

describe("findFilesTool", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "find-files-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports a conclusive zero-match traversal", async () => {
    await writeFile(join(root, "present.txt"), "present\n", "utf8");

    const result = await findFilesTool.execute({
      query: "missing-report.txt",
      roots: [root],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      query: "missing-report.txt",
      kind: "any",
      roots: [root],
      matches: [],
      matchCount: 0,
      maxDepth: 10,
      maxResults: 500,
      includeHidden: false,
      capped: false,
      errors: [],
      errorCount: 0,
      depthLimitedDirectoryCount: 0,
      traversalComplete: true,
    });
  });

  it("finds directories directly and returns their exact kind", async () => {
    const directory = join(root, "cedar-studio");
    await mkdir(directory);
    await writeFile(join(root, "cedar-studio.txt"), "file\n", "utf8");

    const result = await findFilesTool.execute({
      query: "cedar",
      kind: "directory",
      roots: [root],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      query: "cedar",
      kind: "directory",
      matches: [{ absolutePath: directory, kind: "directory" }],
      matchCount: 1,
      traversalComplete: true,
    });
  });

  it("defaults to matching both files and directories", async () => {
    const directory = join(root, "cedar-studio");
    const file = join(root, "cedar-studio.txt");
    await mkdir(directory);
    await writeFile(file, "file\n", "utf8");

    const result = await findFilesTool.execute({
      query: "cedar",
      roots: [root],
    });

    expect(result.v2?.structuredContent).toMatchObject({
      kind: "any",
      matches: expect.arrayContaining([
        { name: "cedar-studio", absolutePath: directory, kind: "directory" },
        { name: "cedar-studio.txt", absolutePath: file, kind: "file" },
      ]),
      matchCount: 2,
    });
  });

  it("finds symbolic links without traversing linked directories", async () => {
    const external = await mkdtemp(join(tmpdir(), "find-files-linked-target-"));
    await writeFile(join(external, "hidden-through-link.txt"), "outside traversal\n", "utf8");
    const link = join(root, "latest-archive");
    await symlink(external, link);

    const linkResult = await findFilesTool.execute({
      query: "latest",
      kind: "symlink",
      roots: [root],
    });
    const traversalResult = await findFilesTool.execute({
      query: "hidden-through-link.txt",
      roots: [root],
    });

    expect(linkResult.ok).toBe(true);
    expect(linkResult.output).toBe(`[symlink] ${link}`);
    expect(linkResult.v2?.structuredContent).toMatchObject({
      kind: "symlink",
      matches: [{ name: "latest-archive", absolutePath: link, kind: "symlink" }],
      matchCount: 1,
      traversalComplete: true,
    });
    expect(traversalResult.v2?.structuredContent).toMatchObject({
      matches: [],
      matchCount: 0,
      traversalComplete: true,
    });

    await rm(external, { recursive: true, force: true });
  });

  it("marks a zero-match search inconclusive when the depth limit skips directories", async () => {
    const levelOne = join(root, "level-one");
    const levelTwo = join(levelOne, "level-two");
    await mkdir(levelTwo, { recursive: true });
    await writeFile(join(levelTwo, "missing-report.txt"), "too deep\n", "utf8");

    const result = await findFilesTool.execute({
      query: "missing-report.txt",
      roots: [root],
      maxDepth: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      matches: [],
      matchCount: 0,
      capped: false,
      errorCount: 0,
      depthLimitedDirectoryCount: 1,
      traversalComplete: false,
    });
  });
});
