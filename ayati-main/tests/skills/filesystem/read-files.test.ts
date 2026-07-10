import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFilesTool } from "../../../src/skills/builtins/filesystem/read-files.js";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";
import { workspaceRoot } from "../../../src/skills/workspace-paths.js";

describe("readFilesTool", () => {
  let tmp: string;
  let workspaceArtifacts: string[];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-read-files-test-"));
    workspaceArtifacts = [];
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await Promise.all(workspaceArtifacts.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("reads a single known file as a one-entry batch", async () => {
    const file = join(tmp, "hello.txt");
    await writeFile(file, "hello\nworld\n", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: file }],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Inspected 1/1 file");
    expect(result.output).toContain("hello");
    expect(result.output).toContain("world");
    expect(result.v2?.structuredContent).toMatchObject({
      summary: {
        requested: 1,
        succeeded: 1,
        failed: 0,
      },
      results: [{
        requestedPath: file,
        ok: true,
        filePath: file,
        mode: "auto",
        lineCount: 2,
        lineCountKnown: true,
        observation: {
          mode: "focused",
        },
      }],
    });
    expect(result.rawOutput).toContain(`## ${file}`);
    expect(result.rawOutput).toContain("hello\nworld");
  });

  it("reads multiple known files in one batch", async () => {
    const index = join(tmp, "index.html");
    const styles = join(tmp, "styles.css");
    await writeFile(index, "<main>\n  <h1>Clay & Co</h1>\n</main>\n", "utf-8");
    await writeFile(styles, ".hero {\n  color: #4a3528;\n}\n", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: index }, { path: styles }],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Inspected 2/2 files");
    expect(result.output).toContain("Clay & Co");
    expect(result.output).toContain(".hero");
    expect(result.v2?.structuredContent).toMatchObject({
      summary: {
        requested: 2,
        succeeded: 2,
        failed: 0,
      },
      results: [
        { requestedPath: index, ok: true, filePath: index, mode: "auto" },
        { requestedPath: styles, ok: true, filePath: styles, mode: "auto" },
      ],
    });
    expect(result.rawOutput).toContain(`## ${index}`);
    expect(result.rawOutput).toContain(`## ${styles}`);
  });

  it("passes through sha256 values from complete explicit full reads", async () => {
    const first = join(tmp, "first.txt");
    const second = join(tmp, "second.txt");
    await writeFile(first, "alpha\n", "utf-8");
    await writeFile(second, "beta\n", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: first, mode: "full" }, { path: second, mode: "full" }],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [
        { requestedPath: first, ok: true, filePath: first, mode: "full", sha256: sha256Text("alpha\n") },
        { requestedPath: second, ok: true, filePath: second, mode: "full", sha256: sha256Text("beta\n") },
      ],
    });
  });

  it("passes through sha256 for a complete single-file full read", async () => {
    const file = join(tmp, "full.txt");
    await writeFile(file, "complete\ncontent\n", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: file, mode: "full" }],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [{
        requestedPath: file,
        ok: true,
        filePath: file,
        mode: "full",
        truncated: false,
        lineCount: 2,
        sha256: sha256Text("complete\ncontent\n"),
      }],
    });
    expect(result.output).toContain("sha256=");
    expect(result.output).toContain(sha256Text("complete\ncontent\n"));
  });

  it("uses the shared file line count for empty files and final newlines", async () => {
    const empty = join(tmp, "empty.txt");
    const finalNewline = join(tmp, "final-newline.txt");
    await writeFile(empty, "", "utf-8");
    await writeFile(finalNewline, "alpha\nbeta\n", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: empty, mode: "full" }, { path: finalNewline, mode: "full" }],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [
        { requestedPath: empty, ok: true, lineCount: 0, lineCountKnown: true },
        { requestedPath: finalNewline, ok: true, lineCount: 2, lineCountKnown: true },
      ],
    });
  });

  it("supports slice mode for a single file", async () => {
    const file = join(tmp, "lines.txt");
    await writeFile(file, "a\nb\nc\nd\ne\n", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: file, mode: "slice", startLine: 2, lineCount: 2 }],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("2: b");
    expect(result.output).toContain("3: c");
    expect(result.v2?.structuredContent).toMatchObject({
      results: [{
        requestedPath: file,
        ok: true,
        mode: "slice",
        startLine: 2,
        endLine: 3,
      }],
    });
  });

  it("supports search mode with focused blocks for a single file", async () => {
    const file = join(tmp, "search.txt");
    await writeFile(file, "alpha\nneedle here\nomega\n", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: file, mode: "search", query: "needle", contextLines: 1 }],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("needle here");
    expect(result.v2?.structuredContent).toMatchObject({
      results: [{
        requestedPath: file,
        ok: true,
        mode: "search",
        query: "needle",
        matchCount: 1,
      }],
    });
  });

  it("adds a metadata advisory for large explicit full reads", async () => {
    const file = join(tmp, "large.txt");
    await writeFile(file, `${"alpha\n".repeat(15_000)}`, "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: file, mode: "full" }],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Advisory:");
    expect(result.output).toContain("inspect_paths");
    expect(result.v2?.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "FILE_METADATA_RECOMMENDED",
        severity: "info",
      }),
    ]));
    expect(result.v2?.structuredContent).toMatchObject({
      observation: {
        stats: {
          fileMetadataAdvisory: true,
        },
      },
    });
  });

  it("applies per-file and total character budgets", async () => {
    const first = join(tmp, "first.txt");
    const second = join(tmp, "second.txt");
    await writeFile(first, `${"a".repeat(80)}\n`, "utf-8");
    await writeFile(second, `${"b".repeat(80)}\n`, "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: first, mode: "full" }, { path: second, mode: "full" }],
      maxPerFileChars: 20,
      maxTotalChars: 35,
    });

    expect(result.ok).toBe(true);
    const structured = result.v2?.structuredContent as {
      results: Array<{ content: string; truncated: boolean }>;
      summary: { totalCharsReturned: number; truncated: number };
    };
    expect(structured.summary.totalCharsReturned).toBeLessThanOrEqual(35);
    expect(structured.summary.truncated).toBeGreaterThan(0);
    expect(structured.results[0]?.content.length).toBeLessThanOrEqual(20);
    expect(structured.results.some((entry) => entry.truncated)).toBe(true);
    expect(result.v2?.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "FILE_METADATA_RECOMMENDED", severity: "info" }),
    ]));
  });

  it("adds a metadata advisory for broad batch reads without failing the read", async () => {
    const files = await Promise.all(["a.txt", "b.txt", "c.txt", "d.txt"].map(async (name) => {
      const path = join(tmp, name);
      await writeFile(path, `${name}\n`, "utf-8");
      return path;
    }));

    const result = await readFilesTool.execute({
      files: files.map((path) => ({ path })),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Advisory:");
    expect(result.output).toContain("inspect_paths");
    expect(result.v2?.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "FILE_METADATA_RECOMMENDED",
        severity: "info",
      }),
    ]));
    expect(result.v2?.structuredContent).toMatchObject({
      observation: {
        stats: {
          fileMetadataAdvisory: true,
        },
      },
    });
  });

  it("rejects more than four files per read_files call with split guidance", async () => {
    const result = await readFilesTool.execute({
      files: ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].map((path) => ({ path })),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("at most 4 entries");
    expect(result.error).toContain("split larger reads into multiple read_files calls");
  });

  it("fails the batch by default when any file fails", async () => {
    const existing = join(tmp, "existing.txt");
    const missing = join(tmp, "missing.txt");
    await writeFile(existing, "existing content\n", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: existing }, { path: missing }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("read_files failed");
    expect(result.output).toContain("existing content");
    expect(result.v2?.structuredContent).toMatchObject({
      summary: {
        requested: 2,
        succeeded: 1,
        failed: 1,
      },
    });
  });

  it("requires query for search mode", async () => {
    const file = join(tmp, "search-missing-query.txt");
    await writeFile(file, "content", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: file, mode: "search" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("read_files failed for every requested file");
    expect(result.output).toContain("requires a non-empty query");
  });

  it("returns error for a missing single file", async () => {
    const result = await readFilesTool.execute({
      files: [{ path: join(tmp, "nope.txt") }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("read_files failed for every requested file");
  });

  it("returns error for a directory path", async () => {
    const result = await readFilesTool.execute({
      files: [{ path: tmp }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("read_files failed for every requested file");
    expect(result.output).toContain("Not a file");
  });

  it("can return partial success when allowMissing is true", async () => {
    const existing = join(tmp, "existing.txt");
    const missing = join(tmp, "missing.txt");
    await writeFile(existing, "existing content\n", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: existing }, { path: missing }],
      allowMissing: true,
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.code).toBe("FILES_INSPECTED_WITH_FAILURES");
    expect(result.v2?.conditions?.some((condition) => condition.code === "READ_FILES_PARTIAL_FAILURE")).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [
        { requestedPath: existing, ok: true },
        { requestedPath: missing, ok: false },
      ],
    });
  });

  it("validates and verifies through the tool executor contract", async () => {
    const file = join(tmp, "contract.txt");
    await writeFile(file, "alpha beta\n", "utf-8");
    const executor = createToolExecutor([readFilesTool]);

    const result = await executor.execute("read_files", {
      files: [{ path: file }, { path: file, mode: "search", query: "beta" }],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.verification?.status).toBe("passed");
    expect(result.v2?.verification?.artifacts).toEqual([
      { kind: "file", path: file },
    ]);
    expect(result.v2?.verification?.facts.some((fact) => fact.kind === "file_read" && fact.path === file)).toBe(true);
  });

  it("rejects invalid nested file inputs", async () => {
    const result = await readFilesTool.execute({
      files: [{ mode: "full" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("files[0]");
    expect(result.error).toContain("path");
  });

  it("rejects null input", async () => {
    const result = await readFilesTool.execute(null);

    expect(result.ok).toBe(false);
  });

  it("reads relative paths from work_space by default", async () => {
    const relativePath = `vitest-read-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const expectedPath = join(workspaceRoot, relativePath);
    workspaceArtifacts.push(expectedPath);
    await writeFile(expectedPath, "workspace read", "utf-8");

    const result = await readFilesTool.execute({
      files: [{ path: relativePath }],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("workspace read");
  });
});

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}
