import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { persistManagedUpload } from "../../src/server/upload-storage.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-upload-storage-"));
}

describe("persistManagedUpload", () => {
  it("persists supported uploads in the managed uploads directory", async () => {
    const dataDir = makeTmpDir();

    try {
      const uploaded = await persistManagedUpload({
        uploadsDir: join(dataDir, "uploads"),
        originalName: "policy.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("Policy body."),
        maxUploadBytes: 1_024,
      });

      expect(uploaded.originalName).toBe("policy.txt");
      expect(uploaded.mimeType).toBe("text/plain");
      expect(uploaded.sizeBytes).toBe(Buffer.byteLength("Policy body."));
      expect(existsSync(uploaded.uploadedPath)).toBe(true);
      expect(readFileSync(uploaded.uploadedPath, "utf-8")).toBe("Policy body.");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported file types", async () => {
    const dataDir = makeTmpDir();

    try {
      await expect(() => persistManagedUpload({
        uploadsDir: join(dataDir, "uploads"),
        originalName: "payload.bin",
        mimeType: "application/octet-stream",
        bytes: new Uint8Array([1, 2, 3]),
        maxUploadBytes: 1_024,
      })).rejects.toThrow("unsupported file type.");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
