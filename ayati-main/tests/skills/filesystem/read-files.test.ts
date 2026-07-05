import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFilesTool } from "../../../src/skills/builtins/filesystem/read-files.js";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";

describe("readFilesTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-read-files-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
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
});
