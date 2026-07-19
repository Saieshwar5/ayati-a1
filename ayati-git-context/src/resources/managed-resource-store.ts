import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { GitContextServiceError } from "../errors.js";

export interface StoredManagedResource {
  resourceId: string;
  contentHash: string;
  storedPath: string;
  displayName: string;
  sizeBytes: number;
  created: boolean;
}

export class ManagedResourceStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async storeFile(sourcePath: string): Promise<StoredManagedResource> {
    const source = await this.requireSource(sourcePath);
    const digest = await hashFile(source);
    const resourceId = "RES-" + digest.slice(0, 24).toUpperCase();
    const directory = join(this.root, "sha256", digest.slice(0, 2));
    const target = join(directory, digest);
    await mkdir(directory, { recursive: true });
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      if (!existing.isFile() || await hashFile(target) !== digest) {
        throw new GitContextServiceError({
          code: "RESOURCE_STORE_CORRUPT",
          message: "Managed resource store contains conflicting bytes.",
          details: { contentHash: digest },
        });
      }
      return {
        resourceId,
        contentHash: digest,
        storedPath: target,
        displayName: basename(source),
        sizeBytes: existing.size,
        created: false,
      };
    }
    const temporary = join(directory, "." + digest + ".tmp-" + process.pid + "-" + crypto.randomUUID());
    try {
      await copyFileExclusive(source, temporary);
      if (await hashFile(temporary) !== digest) {
        throw new Error("Managed upload hash changed while copying.");
      }
      await chmod(temporary, 0o444);
      await rename(temporary, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        await rm(temporary, { force: true });
      });
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    const stored = await lstat(target);
    if (!stored.isFile() || await hashFile(target) !== digest) {
      throw new GitContextServiceError({
        code: "RESOURCE_STORE_CORRUPT",
        message: "Managed upload could not be verified after storage.",
        details: { contentHash: digest },
      });
    }
    return {
      resourceId,
      contentHash: digest,
      storedPath: target,
      displayName: basename(source),
      sizeBytes: stored.size,
      created: true,
    };
  }

  pathFor(resourceId: string, contentHash: string): string {
    const expected = "RES-" + contentHash.slice(0, 24).toUpperCase();
    if (resourceId !== expected || !/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new GitContextServiceError({
        code: "RESOURCE_LOCATOR_INVALID",
        message: "Managed resource identity does not match its content hash.",
      });
    }
    return join(this.root, "sha256", contentHash.slice(0, 2), contentHash);
  }

  private async requireSource(sourcePath: string): Promise<string> {
    const resolved = resolve(sourcePath);
    const stat = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
      throw new GitContextServiceError({
        code: "RESOURCE_NOT_FOUND",
        message: "Attachment source file is unavailable.",
        details: { path: resolved, cause: error.message },
      });
    });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new GitContextServiceError({
        code: "RESOURCE_LOCATOR_INVALID",
        message: "Managed attachments must be normal files.",
        details: { path: resolved },
      });
    }
    const canonical = await realpath(resolved);
    if (isWithin(this.root, canonical)) {
      throw new GitContextServiceError({
        code: "RESOURCE_LOCATOR_INVALID",
        message: "Managed upload source may not be inside the resource store.",
      });
    }
    return canonical;
  }
}

async function copyFileExclusive(source: string, target: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const reader = createReadStream(source);
    const writer = createWriteStream(target, { flags: "wx", mode: 0o600 });
    const fail = (error: Error): void => {
      reader.destroy();
      writer.destroy();
      reject(error);
    };
    reader.on("error", fail);
    writer.on("error", fail);
    writer.on("finish", resolvePromise);
    reader.pipe(writer);
  });
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function isWithin(parent: string, candidate: string): boolean {
  const normalizedParent = resolve(parent) + "/";
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === resolve(parent) || normalizedCandidate.startsWith(normalizedParent);
}
