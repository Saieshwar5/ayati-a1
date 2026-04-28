import { readFile, writeFile } from "node:fs/promises";
import type { ManagedFileRecord } from "./types.js";

export class FileMetadataStore {
  async read(path: string): Promise<ManagedFileRecord | null> {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as ManagedFileRecord;
      return isManagedFileRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async write(path: string, record: ManagedFileRecord): Promise<void> {
    await writeFile(path, JSON.stringify(record, null, 2), "utf-8");
  }
}

function isManagedFileRecord(value: unknown): value is ManagedFileRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<ManagedFileRecord>;
  return typeof record.fileId === "string"
    && typeof record.sha256 === "string"
    && typeof record.originalName === "string"
    && typeof record.storagePath === "string"
    && Array.isArray(record.capabilities);
}
