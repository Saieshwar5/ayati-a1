import {
  isActionId,
  isAssetId,
  isRunId,
  isSessionId,
  isWorkId,
} from "./ids.js";
import { isWorkBranchRef } from "./refs.js";
import type {
  ConversationRecord,
  SessionAssetRecord,
  SessionEventRecord,
  SessionMetaFile,
} from "./session-files.js";
import type {
  TaskAssetRecord,
  TaskFile,
  TaskRunSummaryFile,
  TaskStateFile,
} from "./task-files.js";
import type { ToolActionFile } from "./action-files.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function validateSessionMetaFile(value: unknown): ValidationResult<SessionMetaFile> {
  const errors: string[] = [];
  const record = requireRecord(value, "session meta", errors);
  if (record) {
    requireSchemaVersion(record, errors);
    requireSessionIdField(record, "sessionId", errors);
    requireSessionIdField(record, "date", errors);
    requireNonEmptyString(record, "timezone", errors);
    requireNonEmptyString(record, "createdAt", errors);
  }
  return validationResult(value, errors);
}

export function validateConversationRecord(value: unknown): ValidationResult<ConversationRecord> {
  const errors: string[] = [];
  const record = requireRecord(value, "conversation record", errors);
  if (record) {
    requirePositiveInteger(record, "seq", errors);
    requireOneOf(record, "role", ["user", "assistant", "system"], errors);
    requireNonEmptyString(record, "at", errors);
    requireString(record, "text", errors);
  }
  return validationResult(value, errors);
}

export function validateSessionAssetRecord(value: unknown): ValidationResult<SessionAssetRecord> {
  const errors: string[] = [];
  const record = requireRecord(value, "session asset", errors);
  if (record) {
    requireAssetIdField(record, "assetId", errors);
    requireOneOf(record, "kind", ["user_file", "agent_file", "document", "directory", "artifact"], errors);
    requireNonEmptyString(record, "name", errors);
    requireNonEmptyString(record, "path", errors);
    requireNonEmptyString(record, "createdAt", errors);
  }
  return validationResult(value, errors);
}

export function validateSessionEventRecord(value: unknown): ValidationResult<SessionEventRecord> {
  const errors: string[] = [];
  const record = requireRecord(value, "session event", errors);
  if (record) {
    requirePositiveInteger(record, "seq", errors);
    const type = requireOneOf(record, "type", [
      "session_started",
      "asset_registered",
      "task_branch_created",
      "focus_changed",
      "run_started",
      "run_committed",
      "session_closed",
    ], errors);
    requireNonEmptyString(record, "at", errors);
    if (type === "session_started") {
      requireSessionIdField(record, "sessionId", errors);
    }
    if (type === "asset_registered") {
      requireAssetIdField(record, "assetId", errors);
    }
    if (type === "task_branch_created") {
      requireWorkIdField(record, "workId", errors);
      requireNonEmptyString(record, "branch", errors);
      const ref = requireNonEmptyString(record, "ref", errors);
      if (ref && !isWorkBranchRef(ref)) errors.push("ref must be a valid work branch ref.");
    }
    if (type === "focus_changed") {
      requireNonEmptyString(record, "to", errors);
    }
    if (type === "run_started" || type === "run_committed") {
      requireRunIdField(record, "runId", errors);
      requireWorkIdField(record, "workId", errors);
    }
    if (type === "run_committed") {
      requireNonEmptyString(record, "commit", errors);
    }
  }
  return validationResult(value, errors);
}

export function validateTaskFile(value: unknown): ValidationResult<TaskFile> {
  const errors: string[] = [];
  const record = requireRecord(value, "task file", errors);
  if (record) {
    requireSchemaVersion(record, errors);
    requireWorkIdField(record, "workId", errors);
    requireSessionIdField(record, "sessionId", errors);
    requireNonEmptyString(record, "title", errors);
    requireNonEmptyString(record, "objective", errors);
    requireTaskStatus(record, errors);
    requireNonEmptyString(record, "createdAt", errors);
    requireNonEmptyString(record, "updatedAt", errors);
  }
  return validationResult(value, errors);
}

export function validateTaskStateFile(value: unknown): ValidationResult<TaskStateFile> {
  const errors: string[] = [];
  const record = requireRecord(value, "task state", errors);
  if (record) {
    requireSchemaVersion(record, errors);
    requireWorkIdField(record, "workId", errors);
    requireTaskStatus(record, errors);
    requireStringArray(record, "completed", errors);
    requireStringArray(record, "open", errors);
    requireFacts(record, errors);
  }
  return validationResult(value, errors);
}

export function validateTaskAssetRecord(value: unknown): ValidationResult<TaskAssetRecord> {
  const errors: string[] = [];
  const record = requireRecord(value, "task asset", errors);
  if (record) {
    requireAssetIdField(record, "assetId", errors);
    requireOneOf(record, "role", ["input", "output", "generated", "reference"], errors);
    requireNonEmptyString(record, "kind", errors);
    requireNonEmptyString(record, "name", errors);
  }
  return validationResult(value, errors);
}

export function validateToolActionFile(value: unknown): ValidationResult<ToolActionFile> {
  const errors: string[] = [];
  const record = requireRecord(value, "tool action", errors);
  if (record) {
    requireSchemaVersion(record, errors);
    requireActionIdField(record, "actionId", errors);
    requireRunIdField(record, "runId", errors);
    requireWorkIdField(record, "workId", errors);
    requireNonEmptyString(record, "tool", errors);
    if (!Object.prototype.hasOwnProperty.call(record, "input")) {
      errors.push("input is required.");
    }
    requireOneOf(record, "status", ["success", "failed", "skipped"], errors);
    requireNonEmptyString(record, "summary", errors);
    requireNonEmptyString(record, "createdAt", errors);
  }
  return validationResult(value, errors);
}

export function validateTaskRunSummaryFile(value: unknown): ValidationResult<TaskRunSummaryFile> {
  const errors: string[] = [];
  const record = requireRecord(value, "task run summary", errors);
  if (record) {
    requireSchemaVersion(record, errors);
    requireRunIdField(record, "runId", errors);
    requireWorkIdField(record, "workId", errors);
    requireOneOf(record, "status", ["completed", "failed", "blocked", "needs_user_input"], errors);
    requireNonEmptyString(record, "summary", errors);
    requireStringArray(record, "completed", errors);
    requireStringArray(record, "open", errors);
    requireActionIdArray(record, "actions", errors);
    requireNonEmptyString(record, "createdAt", errors);
  }
  return validationResult(value, errors);
}

function validationResult<T>(value: unknown, errors: string[]): ValidationResult<T> {
  return errors.length === 0
    ? { ok: true, value: value as T }
    : { ok: false, errors };
}

function requireRecord(value: unknown, label: string, errors: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  return value as Record<string, unknown>;
}

function requireSchemaVersion(record: Record<string, unknown>, errors: string[]): void {
  if (record["schemaVersion"] !== 1) {
    errors.push("schemaVersion must be 1.");
  }
}

function requireString(record: Record<string, unknown>, field: string, errors: string[]): string | undefined {
  const value = record[field];
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return undefined;
  }
  return value;
}

function requireNonEmptyString(record: Record<string, unknown>, field: string, errors: string[]): string | undefined {
  const value = requireString(record, field, errors);
  if (value !== undefined && value.trim().length === 0) {
    errors.push(`${field} must not be empty.`);
  }
  return value;
}

function requirePositiveInteger(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    errors.push(`${field} must be a positive integer.`);
  }
}

function requireOneOf<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  errors: string[],
): T | undefined {
  const value = record[field];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(`${field} must be one of: ${allowed.join(", ")}.`);
    return undefined;
  }
  return value as T;
}

function requireSessionIdField(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isSessionId(value)) errors.push(`${field} must be a valid session id.`);
}

function requireWorkIdField(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isWorkId(value)) errors.push(`${field} must be a valid work id.`);
}

function requireRunIdField(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isRunId(value)) errors.push(`${field} must be a valid run id.`);
}

function requireAssetIdField(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isAssetId(value)) errors.push(`${field} must be a valid asset id.`);
}

function requireActionIdField(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isActionId(value)) errors.push(`${field} must be a valid action id.`);
}

function requireTaskStatus(record: Record<string, unknown>, errors: string[]): void {
  requireOneOf(record, "status", ["active", "paused", "blocked", "done", "failed"], errors);
}

function requireStringArray(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    errors.push(`${field} must be an array of strings.`);
  }
}

function requireActionIdArray(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (!Array.isArray(value) || !value.every(isActionId)) {
    errors.push(`${field} must be an array of action ids.`);
  }
}

function requireFacts(record: Record<string, unknown>, errors: string[]): void {
  const value = record["facts"];
  if (!Array.isArray(value)) {
    errors.push("facts must be an array.");
    return;
  }
  for (const fact of value) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
      errors.push("facts items must be objects.");
      continue;
    }
    const factRecord = fact as Record<string, unknown>;
    requireNonEmptyString(factRecord, "text", errors);
    requireNonEmptyString(factRecord, "source", errors);
  }
}
