export type SessionId = string;
export type WorkId = string;
export type RunId = string;
export type AssetId = string;
export type ActionId = string;

const SESSION_ID_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_DATE_PATTERN = /^\d{8}$/;
const WORK_ID_PATTERN = /^W-\d{8}-\d{4}$/;
const RUN_ID_PATTERN = /^R-\d{8}-\d{4}$/;
const ASSET_ID_PATTERN = /^A-\d{8}-\d{4}$/;
const ACTION_ID_PATTERN = /^action-\d{4}$/;

export function isSessionId(value: unknown): value is SessionId {
  return typeof value === "string"
    && SESSION_ID_PATTERN.test(value)
    && isValidCalendarDate(value);
}

export function isWorkId(value: unknown): value is WorkId {
  return typeof value === "string"
    && WORK_ID_PATTERN.test(value)
    && isValidCompactDate(value.slice(2, 10));
}

export function isRunId(value: unknown): value is RunId {
  return typeof value === "string"
    && RUN_ID_PATTERN.test(value)
    && isValidCompactDate(value.slice(2, 10));
}

export function isAssetId(value: unknown): value is AssetId {
  return typeof value === "string"
    && ASSET_ID_PATTERN.test(value)
    && isValidCompactDate(value.slice(2, 10));
}

export function isActionId(value: unknown): value is ActionId {
  return typeof value === "string" && ACTION_ID_PATTERN.test(value);
}

export function createWorkId(sessionId: SessionId, sequence: number): WorkId {
  assertSessionId(sessionId);
  return `W-${compactSessionDate(sessionId)}-${formatSequence(sequence)}`;
}

export function createRunId(sessionId: SessionId, sequence: number): RunId {
  assertSessionId(sessionId);
  return `R-${compactSessionDate(sessionId)}-${formatSequence(sequence)}`;
}

export function createAssetId(sessionId: SessionId, sequence: number): AssetId {
  assertSessionId(sessionId);
  return `A-${compactSessionDate(sessionId)}-${formatSequence(sequence)}`;
}

export function createActionId(sequence: number): ActionId {
  return `action-${formatSequence(sequence)}`;
}

export function formatSequence(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9999) {
    throw new Error(`Sequence must be an integer from 1 to 9999: ${String(sequence)}`);
  }
  return String(sequence).padStart(4, "0");
}

export function compactSessionDate(sessionId: SessionId): string {
  assertSessionId(sessionId);
  return sessionId.replace(/-/g, "");
}

export function sessionIdFromCompactDate(compactDate: string): SessionId {
  if (!isValidCompactDate(compactDate)) {
    throw new Error(`Invalid compact session date: ${compactDate}`);
  }
  return `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
}

export function slugifyTitle(title: string, fallback = "untitled", maxLength = 80): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const bounded = normalized.slice(0, Math.max(1, maxLength)).replace(/-+$/g, "");
  return bounded || fallback;
}

function assertSessionId(sessionId: SessionId): void {
  if (!isSessionId(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

function isValidCompactDate(value: string): boolean {
  if (!COMPACT_DATE_PATTERN.test(value)) {
    return false;
  }
  return isValidCalendarDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
}

function isValidCalendarDate(value: string): boolean {
  const parts = value.split("-");
  if (parts.length !== 3) {
    return false;
  }
  const year = Number(parts[0] ?? "");
  const month = Number(parts[1] ?? "");
  const day = Number(parts[2] ?? "");
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}
