import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunFileReference, RunFilesManifest } from "./types.js";

export class FileStorageLayout {
  readonly dataDir: string;
  readonly filesDir: string;
  readonly runsDir: string;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.filesDir = resolve(this.dataDir, "files");
    this.runsDir = resolve(this.dataDir, "runs");
  }

  fileDir(fileId: string): string {
    return resolve(this.filesDir, fileId);
  }

  originalDir(fileId: string): string {
    return resolve(this.fileDir(fileId), "original");
  }

  derivedDir(fileId: string): string {
    return resolve(this.fileDir(fileId), "derived");
  }

  originalPath(fileId: string, safeName: string): string {
    return resolve(this.originalDir(fileId), safeName);
  }

  metadataPath(fileId: string): string {
    return resolve(this.fileDir(fileId), "metadata.json");
  }

  derivedPath(fileId: string, name: string): string {
    return resolve(this.derivedDir(fileId), name);
  }

  runFilesPath(runId: string): string {
    return resolve(this.runsDir, runId, "files.json");
  }

  async ensureFileDirs(fileId: string): Promise<void> {
    await Promise.all([
      mkdir(this.originalDir(fileId), { recursive: true }),
      mkdir(this.derivedDir(fileId), { recursive: true }),
    ]);
  }

  async appendRunFile(runId: string, reference: RunFileReference): Promise<void> {
    const manifestPath = this.runFilesPath(runId);
    let manifest: RunFilesManifest = { runId, files: [] };

    try {
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as RunFilesManifest;
      if (parsed && parsed.runId === runId && Array.isArray(parsed.files)) {
        manifest = parsed;
      }
    } catch {
      // Create a new manifest below.
    }

    const index = manifest.files.findIndex((entry) => entry.fileId === reference.fileId);
    if (index >= 0) {
      manifest.files[index] = reference;
    } else {
      manifest.files.push(reference);
    }

    await mkdir(join(this.runsDir, runId), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  async readRunFileIds(runId: string): Promise<string[]> {
    try {
      const raw = await readFile(this.runFilesPath(runId), "utf-8");
      const parsed = JSON.parse(raw) as RunFilesManifest;
      if (!parsed || !Array.isArray(parsed.files)) {
        return [];
      }
      return parsed.files.map((entry) => entry.fileId).filter((fileId) => fileId.length > 0);
    } catch {
      return [];
    }
  }
}
