import type { GitMemoryWorktreeGitDriver } from "./git-driver.js";
import type {
  GitMemorySessionId,
  GitMemoryTaskId,
} from "./schema.js";
import {
  isGitMemorySessionId,
  isGitMemoryTaskId,
} from "./schema.js";

export const GIT_MEMORY_CUSTOM_REF_PREFIX = "refs/ayati";

export function gitMemorySessionActiveTaskRef(sessionId: GitMemorySessionId): string {
  assertGitMemorySessionId(sessionId);
  return `${GIT_MEMORY_CUSTOM_REF_PREFIX}/sessions/${sessionId}/active-task`;
}

export function gitMemorySessionLatestRunRef(sessionId: GitMemorySessionId): string {
  assertGitMemorySessionId(sessionId);
  return `${GIT_MEMORY_CUSTOM_REF_PREFIX}/sessions/${sessionId}/latest-run`;
}

export function gitMemorySessionLatestBaseRef(sessionId: GitMemorySessionId): string {
  assertGitMemorySessionId(sessionId);
  return `${GIT_MEMORY_CUSTOM_REF_PREFIX}/sessions/${sessionId}/latest-base`;
}

export function gitMemoryTaskLatestRunRef(taskId: GitMemoryTaskId): string {
  assertGitMemoryTaskId(taskId);
  return `${GIT_MEMORY_CUSTOM_REF_PREFIX}/tasks/${taskId}/latest-run`;
}

export function gitMemoryTaskLatestCheckpointRef(taskId: GitMemoryTaskId): string {
  assertGitMemoryTaskId(taskId);
  return `${GIT_MEMORY_CUSTOM_REF_PREFIX}/tasks/${taskId}/latest-checkpoint`;
}

export async function readGitMemoryCustomRef(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
): Promise<string | null> {
  assertGitMemoryCustomRef(ref);
  return await driver.resolveRef(ref);
}

export async function writeGitMemoryCustomRef(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  targetRef: string,
): Promise<string> {
  assertGitMemoryCustomRef(ref);
  const commit = await driver.resolveRef(targetRef);
  if (!commit) {
    throw new Error(`Git memory custom ref target is missing: ${targetRef}`);
  }
  await driver.updateRef(ref, commit);
  return commit;
}

export function assertGitMemoryCustomRef(ref: string): void {
  if (!ref.startsWith(`${GIT_MEMORY_CUSTOM_REF_PREFIX}/`)) {
    throw new Error(`Git memory custom refs must be under ${GIT_MEMORY_CUSTOM_REF_PREFIX}/: ${ref}`);
  }
  if (!/^refs\/ayati\/[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`Invalid git memory custom ref: ${ref}`);
  }
  if (
    ref.includes("..")
    || ref.includes("//")
    || ref.endsWith("/")
    || ref.endsWith(".")
    || ref.includes("@{")
    || ref.includes("\\")
  ) {
    throw new Error(`Invalid git memory custom ref: ${ref}`);
  }
}

function assertGitMemorySessionId(sessionId: GitMemorySessionId): void {
  if (!isGitMemorySessionId(sessionId)) {
    throw new Error(`Invalid git-memory session id: ${sessionId}`);
  }
}

function assertGitMemoryTaskId(taskId: GitMemoryTaskId): void {
  if (!isGitMemoryTaskId(taskId)) {
    throw new Error(`Invalid git-memory task id: ${taskId}`);
  }
}
