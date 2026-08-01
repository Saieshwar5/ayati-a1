import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectPathsTool } from "../../../src/skills/builtins/filesystem/inspect-paths.js";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";

describe("inspectPathsTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-inspect-paths-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("inspects multiple file metadata entries before content reads", async () => {
    const app = join(tmp, "app.ts");
    const styles = join(tmp, "styles.css");
    await writeFile(app, "export function run() {\n  return true;\n}\n", "utf-8");
    await writeFile(styles, ".hero {\n  color: black;\n}\n", "utf-8");

    const result = await inspectPathsTool.execute({
      paths: [app, styles],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Found 2/2 paths");
    expect(result.output).toContain("recommend read_files:auto");
    expect(result.rawOutput).toContain("\"language\": \"typescript\"");
    expect(result.v2?.structuredContent).toMatchObject({
      summary: {
        requested: 2,
        found: 2,
        missing: 0,
        files: 2,
      },
      results: [
        {
          requestedPath: app,
          path: app,
          ok: true,
          exists: true,
          kind: "file",
          lineCount: 3,
          extension: ".ts",
          language: "typescript",
          contentKind: "text",
          readRecommendation: {
            tool: "read_files",
            mode: "auto",
          },
        },
        {
          requestedPath: styles,
          path: styles,
          ok: true,
          exists: true,
          kind: "file",
          lineCount: 3,
          extension: ".css",
          language: "css",
          contentKind: "text",
        },
      ],
    });
  });

  it("reports exact Unix permission metadata without exposing file content", async () => {
    const file = join(tmp, "private-note.txt");
    const directory = join(tmp, "private-directory");
    await writeFile(file, "secret content must not appear", "utf-8");
    await mkdir(directory);
    await chmod(file, 0o640);
    await chmod(directory, 0o750);

    const result = await inspectPathsTool.execute({
      paths: [file, directory],
      includeLineCount: false,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("mode=0640 (rw-r-----)");
    expect(result.output).toContain("mode=0750 (rwxr-x---)");
    expect(result.output).not.toContain("secret content must not appear");
    expect(result.v2?.structuredContent).toMatchObject({
      results: [
        {
          path: file,
          kind: "file",
          modeOctal: "0640",
          modeSymbolic: "rw-r-----",
        },
        {
          path: directory,
          kind: "directory",
          modeOctal: "0750",
          modeSymbolic: "rwxr-x---",
        },
      ],
    });
  });

  it("inspects directories and missing paths without failing the whole batch", async () => {
    const src = join(tmp, "src");
    await mkdir(src);
    await writeFile(join(src, "index.ts"), "export const value = 1;\n", "utf-8");

    const result = await inspectPathsTool.execute({
      paths: [src, join(tmp, "missing.ts")],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      summary: {
        requested: 2,
        found: 1,
        missing: 1,
        directories: 1,
      },
      results: [
        {
          requestedPath: src,
          ok: true,
          exists: true,
          kind: "directory",
          directoryCounts: {
            files: 1,
            dirs: 0,
            other: 0,
          },
          readRecommendation: {
            tool: "list_directory",
          },
        },
        {
          requestedPath: join(tmp, "missing.ts"),
          ok: false,
          exists: false,
          kind: "missing",
          readRecommendation: {
            tool: "find_files",
          },
        },
      ],
    });
  });

  it("uses the shared file line-count contract and shows hashes when requested", async () => {
    const empty = join(tmp, "empty.txt");
    const finalNewline = join(tmp, "final-newline.txt");
    await writeFile(empty, "", "utf-8");
    await writeFile(finalNewline, "alpha\nbeta\n", "utf-8");

    const result = await inspectPathsTool.execute({
      paths: [empty, finalNewline],
      includeHash: true,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("sha256=");
    expect(result.v2?.structuredContent).toMatchObject({
      results: [
        { path: empty, lineCount: 0 },
        { path: finalNewline, lineCount: 2 },
      ],
    });
  });

  it("detects binary files and recommends avoiding text reads", async () => {
    const file = join(tmp, "image.bin");
    await writeFile(file, Buffer.from([0, 1, 2, 3, 4, 5]));

    const result = await inspectPathsTool.execute({
      paths: [file],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [
        {
          path: file,
          kind: "file",
          contentKind: "binary",
          readRecommendation: {
            tool: "find_files",
          },
        },
      ],
    });
  });

  it("reports symbolic-link and resolved-target metadata without reading target content", async () => {
    const file = join(tmp, "letter.txt");
    const directory = join(tmp, "archive");
    const fileLink = join(tmp, "latest-letter.txt");
    const directoryLink = join(tmp, "latest-archive");
    const brokenLink = join(tmp, "missing-letter.txt");
    await writeFile(file, "private target content", "utf-8");
    await mkdir(directory);
    await symlink(file, fileLink);
    await symlink(directory, directoryLink);
    await symlink(join(tmp, "does-not-exist.txt"), brokenLink);

    const result = await inspectPathsTool.execute({
      paths: [fileLink, directoryLink, brokenLink],
    });

    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("private target content");
    expect(result.output).toContain(`target=${file}`);
    expect(result.v2?.structuredContent).toMatchObject({
      summary: {
        requested: 3,
        found: 3,
        symlinks: 3,
        missing: 0,
      },
      results: [
        {
          path: fileLink,
          kind: "symlink",
          targetPath: file,
          targetKind: "file",
          targetExists: true,
          readRecommendation: { tool: "read_files" },
        },
        {
          path: directoryLink,
          kind: "symlink",
          targetPath: directory,
          targetKind: "directory",
          targetExists: true,
          readRecommendation: { tool: "list_directory" },
        },
        {
          path: brokenLink,
          kind: "symlink",
          targetPath: join(tmp, "does-not-exist.txt"),
          targetKind: "missing",
          targetExists: false,
          readRecommendation: { tool: "find_files" },
        },
      ],
    });
  });

  it("validates and verifies through the tool executor contract", async () => {
    const file = join(tmp, "contract.txt");
    await writeFile(file, "alpha\nbeta\n", "utf-8");
    const executor = createToolExecutor([inspectPathsTool]);

    const result = await executor.execute("inspect_paths", {
      paths: [file],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.verification?.status).toBe("passed");
  });

  it("rejects invalid path batches", async () => {
    const result = await inspectPathsTool.execute({
      paths: [],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("paths");
  });
});
