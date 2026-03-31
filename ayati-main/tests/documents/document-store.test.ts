import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DocumentStore } from "../../src/documents/document-store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-doc-store-"));
}

describe("DocumentStore.registerAttachments", () => {
  it("keeps CLI registration working and records source metadata", async () => {
    const dataDir = makeTmpDir();
    const attachmentPath = join(dataDir, "policy.txt");
    writeFileSync(attachmentPath, "Termination requires 30 days notice.", "utf-8");

    try {
      const store = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });

      const result = await store.registerAttachments([{ path: attachmentPath, name: "policy.txt" }]);

      expect(result.warnings).toEqual([]);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toEqual(expect.objectContaining({
        source: "cli",
        displayName: "policy.txt",
        originalPath: attachmentPath,
        kind: "txt",
      }));
      expect(existsSync(result.documents[0]!.storedPath)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("registers uploaded web files from the managed uploads directory", async () => {
    const dataDir = makeTmpDir();
    const documentsDir = join(dataDir, "documents");
    const uploadPath = join(documentsDir, "uploads", "upload-1", "policy.txt");
    mkdirSync(dirname(uploadPath), { recursive: true });
    writeFileSync(uploadPath, "Uploaded policy text.", "utf-8");

    try {
      const store = new DocumentStore({
        dataDir: documentsDir,
        preferCli: false,
      });

      const result = await store.registerAttachments([
        {
          source: "web",
          uploadedPath: uploadPath,
          originalName: "policy.txt",
          mimeType: "text/plain",
          sizeBytes: readFileSync(uploadPath).length,
        },
      ]);

      expect(result.warnings).toEqual([]);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toEqual(expect.objectContaining({
        source: "web",
        displayName: "policy.txt",
        originalPath: uploadPath,
        kind: "txt",
      }));
      expect(readFileSync(result.documents[0]!.storedPath, "utf-8")).toBe("Uploaded policy text.");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("warns on missing uploaded paths, empty files, and unsupported types", async () => {
    const dataDir = makeTmpDir();
    const documentsDir = join(dataDir, "documents");
    const missingUploadPath = join(documentsDir, "uploads", "missing", "policy.txt");
    const emptyUploadPath = join(documentsDir, "uploads", "empty", "policy.txt");
    const unsupportedUploadPath = join(documentsDir, "uploads", "unknown", "payload.bin");

    mkdirSync(dirname(emptyUploadPath), { recursive: true });
    mkdirSync(dirname(unsupportedUploadPath), { recursive: true });
    writeFileSync(emptyUploadPath, "", "utf-8");
    writeFileSync(unsupportedUploadPath, "bytes", "utf-8");

    try {
      const store = new DocumentStore({
        dataDir: documentsDir,
        preferCli: false,
      });

      const result = await store.registerAttachments([
        {
          source: "web",
          uploadedPath: missingUploadPath,
          originalName: "policy.txt",
          mimeType: "text/plain",
        },
        {
          source: "web",
          uploadedPath: emptyUploadPath,
          originalName: "policy.txt",
          mimeType: "text/plain",
          sizeBytes: 0,
        },
        {
          source: "web",
          uploadedPath: unsupportedUploadPath,
          originalName: "payload.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 5,
        },
      ]);

      expect(result.documents).toEqual([]);
      expect(result.warnings).toHaveLength(3);
      expect(result.warnings.join("\n")).toContain("missing");
      expect(result.warnings.join("\n")).toContain("empty");
      expect(result.warnings.join("\n")).toContain("unsupported");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("dedupes duplicate uploads by checksum-based document ids", async () => {
    const dataDir = makeTmpDir();
    const documentsDir = join(dataDir, "documents");
    const uploadPathA = join(documentsDir, "uploads", "upload-a", "policy.txt");
    const uploadPathB = join(documentsDir, "uploads", "upload-b", "policy.txt");
    const contents = "Same document body.";
    mkdirSync(dirname(uploadPathA), { recursive: true });
    mkdirSync(dirname(uploadPathB), { recursive: true });
    writeFileSync(uploadPathA, contents, "utf-8");
    writeFileSync(uploadPathB, contents, "utf-8");

    try {
      const store = new DocumentStore({
        dataDir: documentsDir,
        preferCli: false,
      });

      const [first, second] = (await store.registerAttachments([
        {
          source: "web",
          uploadedPath: uploadPathA,
          originalName: "policy.txt",
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength(contents),
        },
        {
          source: "web",
          uploadedPath: uploadPathB,
          originalName: "policy-copy.txt",
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength(contents),
        },
      ])).documents;

      expect(first?.documentId).toBe(second?.documentId);
      expect(first?.checksum).toBe(second?.checksum);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
