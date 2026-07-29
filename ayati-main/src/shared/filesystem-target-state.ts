import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  FilesystemTargetPrecondition,
  FilesystemTargetState,
} from "../skills/types.js";
import {
  canonicalizeAbsoluteFilesystemPath,
  type CanonicalFilesystemPath,
} from "./filesystem-paths.js";

/**
 * Canonicalize the existing parent of one filesystem entry without following
 * the final entry when it is a symbolic link.
 */
export async function canonicalizeFilesystemEntryPath(
  path: string,
): Promise<CanonicalFilesystemPath> {
  const absolute = resolve(path);
  if (dirname(absolute) === absolute) {
    return await canonicalizeAbsoluteFilesystemPath(absolute);
  }
  const parent = await canonicalizeAbsoluteFilesystemPath(dirname(absolute));
  return resolve(parent, basename(absolute)) as CanonicalFilesystemPath;
}

export async function observeFilesystemTarget(
  path: string,
): Promise<FilesystemTargetState> {
  const state = await lstat(path).catch(missingPath);
  if (!state) return { kind: "missing" };
  const identity = {
    device: state.dev,
    inode: state.ino,
    mode: state.mode & 0o777,
  };
  if (state.isSymbolicLink()) {
    return {
      kind: "symlink",
      linkTarget: await readlink(path),
      ...identity,
    };
  }
  if (state.isFile()) {
    return {
      kind: "file",
      sizeBytes: state.size,
      sha256: await sha256File(path),
      linkCount: state.nlink,
      ...identity,
    };
  }
  if (state.isDirectory()) {
    return {
      kind: "directory",
      ...identity,
    };
  }
  return {
    kind: "other",
    ...identity,
  };
}

export function sameFilesystemTargetState(
  left: FilesystemTargetState,
  right: FilesystemTargetState,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing" && right.kind === "missing") return true;
  if (left.kind === "file" && right.kind === "file") {
    return left.sha256 === right.sha256
      && left.mode === right.mode
      && left.linkCount === right.linkCount
      && left.device === right.device
      && left.inode === right.inode;
  }
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.linkTarget === right.linkTarget
      && left.device === right.device
      && left.inode === right.inode;
  }
  if (
    (left.kind === "directory" && right.kind === "directory")
    || (left.kind === "other" && right.kind === "other")
  ) {
    return left.mode === right.mode
      && left.device === right.device
      && left.inode === right.inode;
  }
  return false;
}

export function summarizeFilesystemTargetState(
  state: FilesystemTargetState,
): Record<string, unknown> {
  if (state.kind === "missing") return { kind: state.kind };
  if (state.kind === "file") {
    return {
      kind: state.kind,
      sha256: state.sha256,
      sizeBytes: state.sizeBytes,
      mode: state.mode,
      linkCount: state.linkCount,
      device: state.device,
      inode: state.inode,
    };
  }
  if (state.kind === "symlink") {
    return {
      kind: state.kind,
      linkTarget: state.linkTarget,
      mode: state.mode,
      device: state.device,
      inode: state.inode,
    };
  }
  return {
    kind: state.kind,
    mode: state.mode,
    device: state.device,
    inode: state.inode,
  };
}

export function filesystemPreconditionMap(
  values: FilesystemTargetPrecondition[] | undefined,
): Map<string, FilesystemTargetState> {
  return new Map((values ?? []).map((value) => [
    resolve(value.path),
    value.expected,
  ]));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function missingPath(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}
