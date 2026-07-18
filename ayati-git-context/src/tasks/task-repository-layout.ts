import { isAbsolute, posix } from "node:path";
import { GitContextServiceError } from "../errors.js";

export const TASK_CARD_PATH = ".ayati/task.md";
export const TASK_REQUESTS_DIRECTORY = ".ayati/requests";
export const TASK_REFERENCES_PATH = ".ayati/references.md";
export const TASK_INBOX_DIRECTORY = ".ayati/inbox";
export const TASK_INBOX_KEEP_PATH = ".ayati/inbox/.gitkeep";
export const TASK_SCHEMA = "ayati.task/v1";
export const TASK_REQUEST_SCHEMA = "ayati.request/v1";

const TASK_ID_PATTERN = /^T-\d{8}-\d{4}$/;
const REQUEST_ID_PATTERN = /^R-\d{4}$/;
const REFERENCE_ID_PATTERN = /^REF-\d{4}$/;

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

export function isRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

export function isReferenceId(value: string): boolean {
  return REFERENCE_ID_PATTERN.test(value);
}

export function requireTaskId(value: string): string {
  if (!isTaskId(value)) {
    throw new GitContextServiceError({
      code: "TASK_CARD_INVALID",
      message: "Task ID must use T-YYYYMMDD-NNNN.",
      details: { field: "id", value },
    });
  }
  return value;
}

export function requireRequestId(value: string): string {
  if (!isRequestId(value)) {
    throw new GitContextServiceError({
      code: "TASK_REQUEST_INVALID",
      message: "Request ID must use R-NNNN.",
      details: { field: "id", value },
    });
  }
  return value;
}

export function requireReferenceId(value: string): string {
  if (!isReferenceId(value)) {
    throw new GitContextServiceError({
      code: "TASK_REFERENCES_INVALID",
      message: "Reference ID must use REF-NNNN.",
      details: { field: "id", value },
    });
  }
  return value;
}

export function taskSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function taskDirectoryName(taskId: string, title: string): string {
  return requireTaskId(taskId) + "-" + taskSlug(title);
}

export function requestFileName(requestId: string, title: string): string {
  return requireRequestId(requestId) + "-" + taskSlug(title) + ".md";
}

export function requestPath(requestId: string, title: string): string {
  return TASK_REQUESTS_DIRECTORY + "/" + requestFileName(requestId, title);
}

export function normalizePortableTaskPath(value: string, input?: {
  allowAyati?: boolean;
  errorCode?: "TASK_CARD_INVALID" | "TASK_REQUEST_INVALID" | "TASK_REFERENCES_INVALID";
}): string {
  const errorCode = input?.errorCode ?? "TASK_CARD_INVALID";
  const trimmed = value.trim().replaceAll("\\", "/");
  const normalized = posix.normalize(trimmed);
  const rawSegments = trimmed.split("/");
  const segments = normalized.split("/");
  if (!trimmed
    || isAbsolute(trimmed)
    || trimmed.startsWith("/")
    || /^[A-Za-z]:\//.test(trimmed)
    || /[\u0000-\u001f\u007f]/.test(trimmed)
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || rawSegments.includes("..")
    || segments.includes("..")
    || segments.includes(".git")
    || (!input?.allowAyati && segments[0] === ".ayati")) {
    throw new GitContextServiceError({
      code: errorCode,
      message: "Task paths must be portable relative paths inside task-owned content.",
      details: { path: value },
    });
  }
  return normalized.replace(/^\.\//, "");
}

export function nextRequestId(existingIds: Iterable<string>): string {
  return nextScopedId(existingIds, "R-", requireRequestId);
}

export function nextReferenceId(existingIds: Iterable<string>): string {
  return nextScopedId(existingIds, "REF-", requireReferenceId);
}

function nextScopedId(
  existingIds: Iterable<string>,
  prefix: string,
  validate: (value: string) => string,
): string {
  let largest = 0;
  for (const value of existingIds) {
    validate(value);
    largest = Math.max(largest, Number(value.slice(prefix.length)));
  }
  if (largest >= 9_999) {
    throw new GitContextServiceError({
      code: prefix === "R-" ? "TASK_REQUEST_INVALID" : "TASK_REFERENCES_INVALID",
      message: "The task has exhausted its V1 scoped identifier range.",
    });
  }
  return prefix + String(largest + 1).padStart(4, "0");
}
