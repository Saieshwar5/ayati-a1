import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DocumentProcessor } from "../../src/documents/document-processor.js";

describe("DocumentProcessor", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ayati-docs-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts local text attachments", async () => {
    const filePath = join(tempDir, "notes.txt");
    await writeFile(filePath, "Line one\n\nLine two", "utf8");

    const processor = new DocumentProcessor();
    const result = await processor.processAttachments([{ path: filePath }]);

    expect(result.errors).toHaveLength(0);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.kind).toBe("txt");
    expect(result.documents[0]?.segments.length).toBeGreaterThan(0);
    expect(result.documents[0]?.segments[0]?.text).toContain("Line one");
  });

  it("returns an error for missing attachments", async () => {
    const processor = new DocumentProcessor();
    const missingPath = join(tempDir, "missing.txt");

    const result = await processor.processAttachments([{ path: missingPath }]);
    expect(result.documents).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toContain("missing.txt");
  });
});
