import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileLibrary } from "../../src/files/file-library.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-file-library-"));
}

describe("FileLibrary", () => {
  it("registers uploaded text files, writes metadata, and extracts text", async () => {
    const dataDir = makeTmpDir();
    try {
      const library = new FileLibrary({ dataDir });
      const file = await library.registerUpload({
        originalName: "notes.txt",
        bytes: Buffer.from("Important notes\n\nRemember the fileId."),
        mimeType: "text/plain",
        origin: "user_upload",
        runId: "run-1",
      });

      expect(file.fileId).toMatch(/^file_[a-f0-9]{16}$/);
      expect(file.capabilities).toEqual(["text"]);
      expect(existsSync(join(dataDir, "files", file.fileId, "original", "notes.txt"))).toBe(true);
      expect(readFileSync(join(dataDir, "files", file.fileId, "metadata.json"), "utf-8")).toContain("notes.txt");

      const text = await library.readText(file.fileId);
      expect(String(text["text"])).toContain("Remember the fileId.");
      expect(existsSync(join(dataDir, "runs", "run-1", "files.json"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("registers local csv files and queries their staged table", async () => {
    const dataDir = makeTmpDir();
    const csvPath = join(dataDir, "sales.csv");
    writeFileSync(csvPath, "month,amount\nJan,120\nFeb,180\n", "utf-8");

    try {
      const library = new FileLibrary({ dataDir });
      const file = await library.registerPath({
        path: csvPath,
        runId: "run-2",
      });

      expect(file.capabilities).toEqual(["table"]);
      const profile = await library.profileTable({ fileId: file.fileId });
      expect(profile["rowCount"]).toBe(2);
      expect(profile["columns"]).toEqual(["month", "amount"]);

      const query = await library.queryTable({
        fileId: file.fileId,
        sql: "SELECT SUM(amount) AS total FROM file_data",
      });
      expect(JSON.stringify(query["rows"])).toContain("300");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("dedupes registered files by content hash", async () => {
    const dataDir = makeTmpDir();
    try {
      const library = new FileLibrary({ dataDir });
      const first = await library.registerUpload({
        originalName: "first.txt",
        bytes: Buffer.from("same body"),
        origin: "user_upload",
      });
      const second = await library.registerUpload({
        originalName: "second.txt",
        bytes: Buffer.from("same body"),
        origin: "user_upload",
      });

      expect(second.fileId).toBe(first.fileId);
      expect(second.sha256).toBe(first.sha256);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
