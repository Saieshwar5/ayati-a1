import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
