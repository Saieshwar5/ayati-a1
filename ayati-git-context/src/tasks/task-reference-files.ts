import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { GitContextServiceError } from "../errors.js";
import {
  normalizePortableTaskPath,
  TASK_INBOX_DIRECTORY,
} from "./task-repository-layout.js";
import type {
  TaskReference,
  TaskReferenceAvailability,
} from "./task-references.js";

export async function placeTaskInboxAttachment(input: {
  repositoryPath: string;
  referenceId: string;
  label: string;
  sourcePath: string;
  sha256: string;
}): Promise<string> {
  const fileName = input.referenceId + "-" + safeFileName(input.label);
  const relativePath = TASK_INBOX_DIRECTORY + "/" + fileName;
  await copyFileAtomicallyVerified({
    sourcePath: input.sourcePath,
    destinationPath: resolve(input.repositoryPath, relativePath),
    expectedSha256: input.sha256,
    allowExisting: true,
  });
  return relativePath;
}

export async function adoptTaskReferenceFile(input: {
  repositoryPath: string;
  sourcePath: string;
  destinationPath: string;
  sha256: string;
}): Promise<{ destinationPath: string; sha256: string }> {
  const destinationPath = normalizePortableTaskPath(input.destinationPath);
  await copyFileAtomicallyVerified({
    sourcePath: input.sourcePath,
    destinationPath: resolve(input.repositoryPath, destinationPath),
    expectedSha256: input.sha256,
    allowExisting: true,
  });
  return { destinationPath, sha256: normalizeSha256(input.sha256) };
}

export async function resolveTaskReferenceAvailability(
  repositoryPath: string,
  reference: TaskReference,
): Promise<TaskReferenceAvailability> {
  if (reference.kind === "url") return "unchecked";
  const path = reference.kind === "attachment" || reference.kind === "task_path"
    ? resolve(repositoryPath, reference.location)
    : reference.location;
  if (!isAbsolute(path)) return "unchecked";
  const info = await lstat(path).catch(() => undefined);
  if (!info) return "missing";
  if (info.isSymbolicLink()) return "changed";
  if (reference.kind === "external_directory") {
    return info.isDirectory() ? "available" : "changed";
  }
  if (!info.isFile()) return "changed";
  if (!reference.sha256) return "available";
  return await sha256File(path) === reference.sha256 ? "available" : "changed";
}

export async function resolveTaskReferenceAvailabilities(
  repositoryPath: string,
  references: readonly TaskReference[],
): Promise<TaskReference[]> {
  return await Promise.all(references.map(async (reference) => ({
    ...reference,
    availability: await resolveTaskReferenceAvailability(repositoryPath, reference),
  })));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return "sha256:" + hash.digest("hex");
}

async function copyFileAtomicallyVerified(input: {
  sourcePath: string;
  destinationPath: string;
  expectedSha256: string;
  allowExisting: boolean;
}): Promise<void> {
  const expected = normalizeSha256(input.expectedSha256);
  const sourceInfo = await lstat(input.sourcePath).catch(() => undefined);
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) {
    throw invalid("Attachment source must be an available regular file.");
  }
  if (await sha256File(input.sourcePath) !== expected) {
    throw invalid("Attachment source checksum does not match its retained identity.");
  }
  const existing = await lstat(input.destinationPath).catch(() => undefined);
  if (existing) {
    if (input.allowExisting && existing.isFile() && !existing.isSymbolicLink()
      && await sha256File(input.destinationPath) === expected) {
      return;
    }
    throw recovery("Attachment destination already exists with a different identity.", {
      path: input.destinationPath,
    });
  }

  const directory = dirname(input.destinationPath);
  await mkdir(directory, { recursive: true });
  const canonicalDirectory = await realpath(directory);
  if (!input.destinationPath.startsWith(canonicalDirectory + sep)) {
    throw recovery("Attachment destination escaped its canonical directory.");
  }
  const temporaryPath = input.destinationPath + ".tmp-" + process.pid + "-" + crypto.randomUUID();
  try {
    await copyFile(input.sourcePath, temporaryPath);
    const temporary = await open(temporaryPath, "r+");
    try {
      await temporary.chmod(0o600);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    if (await sha256File(temporaryPath) !== expected) {
      throw recovery("Atomic attachment copy did not preserve the source checksum.");
    }
    await link(temporaryPath, input.destinationPath);
    await rm(temporaryPath, { force: true });
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    const raced = await lstat(input.destinationPath).catch(() => undefined);
    if (input.allowExisting && raced?.isFile() && !raced.isSymbolicLink()
      && await sha256File(input.destinationPath) === expected) {
      return;
    }
    throw error;
  }
}

function safeFileName(value: string): string {
  const normalized = basename(value)
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return normalized || "attachment";
}

function normalizeSha256(value: string): string {
  const normalized = value.startsWith("sha256:") ? value : "sha256:" + value;
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    throw invalid("Attachment checksum must be a lowercase SHA-256 identity.");
  }
  return normalized;
}

function invalid(message: string): GitContextServiceError {
  return new GitContextServiceError({ code: "INVALID_REQUEST", message });
}

function recovery(message: string, details?: Record<string, unknown>): GitContextServiceError {
  return new GitContextServiceError({
    code: "RECOVERY_REQUIRED",
    message,
    ...(details ? { details } : {}),
  });
}
