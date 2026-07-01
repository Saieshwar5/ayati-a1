import type { TaskAssetRecord } from "../contracts.js";

export const GIT_MEMORY_SCHEMA_VERSION = 1;

export const GIT_MEMORY_SESSION_META_PATH = "session/meta.json";
export const GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH = "session/conversation.md";
export const GIT_MEMORY_SESSION_MESSAGES_DIR = "session/messages";
export const GIT_MEMORY_SESSION_STORE_DIR = "session-store";
export const GIT_MEMORY_SESSION_STORE_SESSIONS_DIR = "sessions";
export const GIT_MEMORY_SESSION_SCHEMA_PATH = "session/schema.json";

export type GitMemorySessionId = string;
export type GitMemoryTaskId = string;
export type GitMemoryRunId = string;
export type GitMemoryActionId = string;

export type GitMemoryConversationRole = "user" | "assistant" | "system";
export type GitMemoryTaskStatus = "open" | "in_progress" | "blocked" | "done" | "abandoned";
export type GitMemoryRunStatus = "completed" | "failed" | "blocked" | "needs_user_input";
export type GitMemoryActionStatus = "completed" | "failed" | "skipped";
export type GitMemoryCommitEventType =
  | "session_initialized"
  | "session_checkpointed"
  | "conversation_appended"
  | "task_created"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "session_closed";

export interface GitMemorySessionMetaFile {
  schemaVersion: 1;
  sessionId: GitMemorySessionId;
  date: string;
  timezone: string;
  createdAt: string;
  repoKind: "daily_session";
  agentId: string;
}

export interface GitMemorySessionSummaryMetaFile {
  schemaVersion: 1;
  formatVersion?: 1;
  sessionId: GitMemorySessionId;
  updatedAt: string;
  coveredUntilSeq?: number;
  messageCount?: number;
}

export interface GitMemoryConversationRecord {
  seq: number;
  role: GitMemoryConversationRole;
  at: string;
  text?: string | null;
  contentRef?: string | null;
  sha256?: string;
  taskId?: GitMemoryTaskId | null;
  runId?: GitMemoryRunId | null;
  branch?: string | null;
}

export interface GitMemoryConversationSeqRange {
  fromSeq: number;
  toSeq: number;
}

export interface GitMemoryTaskStateFile {
  schemaVersion: 1;
  status: GitMemoryTaskStatus;
  summary: string;
  completed: string[];
  open: string[];
  blockers: string[];
  facts: string[];
  next: string;
  updatedAt: string;
}

export interface GitMemoryTaskAssetsFile {
  schemaVersion: 1;
  assets: TaskAssetRecord[];
}

export interface GitMemoryRunFile {
  schemaVersion: 1;
  runId: GitMemoryRunId;
  taskId: GitMemoryTaskId;
  status: GitMemoryRunStatus;
  startedAt: string;
  completedAt?: string;
  conversationRefs: GitMemoryConversationSeqRange[];
  sessionStoreCommit?: string;
  summary: string;
  intent?: string;
  routing?: string;
  outcome?: string;
  workPerformed?: string[];
  verification?: string[];
  decisions?: string[];
  blockers?: string[];
  assistantResponse?: string;
  toolCallCount: number;
  changedFiles: string[];
  newFacts: string[];
  next?: string;
}

export interface GitMemoryActionRecord {
  v: 1;
  actionId: GitMemoryActionId;
  runId: GitMemoryRunId;
  tool: string;
  status: GitMemoryActionStatus;
  summary: string;
  startedAt: string;
  completedAt?: string;
  evidenceRef?: string;
}

export interface GitMemoryEvidenceManifestRecord {
  v: 1;
  runId: GitMemoryRunId;
  taskId: GitMemoryTaskId;
  step?: number;
  actionId?: GitMemoryActionId;
  tool: string;
  status?: GitMemoryActionStatus;
  summary: string;
  evidenceRef?: string;
  artifacts: string[];
  facts: string[];
  accessModes: string[];
  outputSize?: number;
  lineCount?: number;
  truncated?: boolean;
  source?: Record<string, unknown>;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function gitMemoryTaskDir(taskId: GitMemoryTaskId): string {
  return `tasks/${taskId}`;
}

export function gitMemoryTaskMarkdownPath(taskId: GitMemoryTaskId): string {
  return `${gitMemoryTaskDir(taskId)}/task.md`;
}

export function gitMemoryTaskStatePath(taskId: GitMemoryTaskId): string {
  return `${gitMemoryTaskDir(taskId)}/state.json`;
}

export function gitMemoryTaskRunPath(taskId: GitMemoryTaskId, runId: GitMemoryRunId): string {
  return `${gitMemoryTaskDir(taskId)}/runs/${runId}.json`;
}

export function gitMemoryTaskRunMarkdownPath(taskId: GitMemoryTaskId, runId: GitMemoryRunId): string {
  return `${gitMemoryTaskDir(taskId)}/runs/${runId}.md`;
}

export function gitMemoryTaskActionsPath(taskId: GitMemoryTaskId, runId: GitMemoryRunId): string {
  return `${gitMemoryTaskDir(taskId)}/actions/${runId}.jsonl`;
}

export function gitMemoryTaskEvidenceManifestPath(taskId: GitMemoryTaskId, runId: GitMemoryRunId): string {
  return `${gitMemoryTaskDir(taskId)}/evidence/${runId}/manifest.jsonl`;
}

export function gitMemoryTaskAssetsPath(taskId: GitMemoryTaskId): string {
  return `${gitMemoryTaskDir(taskId)}/assets.json`;
}

export function gitMemoryTaskNotesPath(taskId: GitMemoryTaskId): string {
  return `${gitMemoryTaskDir(taskId)}/notes.md`;
}

export function gitMemoryTaskContextPath(taskId: GitMemoryTaskId): string {
  return `${gitMemoryTaskDir(taskId)}/context.md`;
}

export function gitMemoryTaskConversationDir(taskId: GitMemoryTaskId): string {
  return `${gitMemoryTaskDir(taskId)}/conversation`;
}

export function gitMemoryTaskConversationMessagePath(
  taskId: GitMemoryTaskId,
  seq: number,
  role: GitMemoryConversationRole,
): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`Invalid git-memory conversation sequence: ${seq}`);
  }
  return `${gitMemoryTaskConversationDir(taskId)}/${formatSequence(seq, 6)}-${role}.md`;
}

export function gitMemorySessionMessagePath(seq: number, role: GitMemoryConversationRole): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`Invalid git-memory conversation sequence: ${seq}`);
  }
  return `${GIT_MEMORY_SESSION_MESSAGES_DIR}/${formatSequence(seq, 6)}-${role}.md`;
}

export function gitMemorySessionStoreSessionDir(sessionId: GitMemorySessionId): string {
  if (!isGitMemorySessionId(sessionId)) {
    throw new Error(`Invalid git-memory session id: ${sessionId}`);
  }
  return `${GIT_MEMORY_SESSION_STORE_SESSIONS_DIR}/${sessionId}`;
}

export function gitMemorySessionStoreMessagesDir(sessionId: GitMemorySessionId): string {
  return `${gitMemorySessionStoreSessionDir(sessionId)}/messages`;
}

export function gitMemorySessionStoreSummaryMarkdownPath(sessionId: GitMemorySessionId): string {
  return `${gitMemorySessionStoreSessionDir(sessionId)}/summary.md`;
}

export function gitMemorySessionStoreSummaryMetaPath(sessionId: GitMemorySessionId): string {
  return `${gitMemorySessionStoreSessionDir(sessionId)}/summary.json`;
}

export function gitMemorySessionStoreMessagePath(
  sessionId: GitMemorySessionId,
  seq: number,
  role: GitMemoryConversationRole,
): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`Invalid git-memory conversation sequence: ${seq}`);
  }
  return `${gitMemorySessionStoreMessagesDir(sessionId)}/${formatSequence(seq, 6)}-${role}.md`;
}

export function createGitMemoryTaskId(date: string, sequence: number): GitMemoryTaskId {
  if (!isValidCalendarDate(date)) {
    throw new Error(`Invalid git-memory task date: ${date}`);
  }
  return `W-${date.replace(/-/g, "")}-${formatSequence(sequence, 4)}`;
}

export function createGitMemoryRunId(date: string, sequence: number): GitMemoryRunId {
  if (!isValidCalendarDate(date)) {
    throw new Error(`Invalid git-memory run date: ${date}`);
  }
  return `R-${date.replace(/-/g, "")}-${formatSequence(sequence, 4)}`;
}

export function createGitMemoryActionId(date: string, sequence: number): GitMemoryActionId {
  if (!isValidCalendarDate(date)) {
    throw new Error(`Invalid git-memory action date: ${date}`);
  }
  return `ACT-${date.replace(/-/g, "")}-${formatSequence(sequence, 6)}`;
}

export function createGitMemorySessionId(date: string, agentId: string): GitMemorySessionId {
  if (!isValidCalendarDate(date)) {
    throw new Error(`Invalid git-memory session date: ${date}`);
  }
  const normalizedAgentId = slugifyIdPart(agentId, "local");
  return `S-${date.replace(/-/g, "")}-${normalizedAgentId}`;
}

export function gitMemoryDateFromSessionId(sessionId: GitMemorySessionId): string {
  if (!isGitMemorySessionId(sessionId)) {
    throw new Error(`Invalid git-memory session id: ${sessionId}`);
  }
  const compactDate = sessionId.slice(2, 10);
  return `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
}

export function buildGitMemoryTaskBranchName(taskId: GitMemoryTaskId, title: string): string {
  if (!isGitMemoryTaskId(taskId)) {
    throw new Error(`Invalid git-memory task id: ${taskId}`);
  }
  return `task/${taskId}-${slugifyIdPart(title, "task")}`;
}

export function buildGitMemoryTaskBranchRef(taskId: GitMemoryTaskId, title: string): string {
  return `refs/heads/${buildGitMemoryTaskBranchName(taskId, title)}`;
}

export function isGitMemorySessionId(value: unknown): value is GitMemorySessionId {
  return typeof value === "string"
    && /^S-\d{8}-[a-z0-9][a-z0-9-]{0,39}$/.test(value)
    && isValidCompactDate(value.slice(2, 10));
}

export function isGitMemoryTaskId(value: unknown): value is GitMemoryTaskId {
  return typeof value === "string"
    && /^W-\d{8}-\d{4}$/.test(value)
    && isValidCompactDate(value.slice(2, 10));
}

export function isGitMemoryRunId(value: unknown): value is GitMemoryRunId {
  return typeof value === "string"
    && /^R-\d{8}-\d{4}$/.test(value)
    && isValidCompactDate(value.slice(2, 10));
}

export function isGitMemoryActionId(value: unknown): value is GitMemoryActionId {
  return typeof value === "string"
    && /^ACT-\d{8}-\d{6}$/.test(value)
    && isValidCompactDate(value.slice(4, 12));
}

export function isGitMemoryTaskBranchName(value: unknown): value is string {
  return typeof value === "string"
    && /^task\/W-\d{8}-\d{4}(-[a-z0-9][a-z0-9-]{0,79})?$/.test(value)
    && isValidCompactDate(value.slice(7, 15));
}

export function validateGitMemorySessionMetaFile(value: unknown): ValidationResult<GitMemorySessionMetaFile> {
  const errors: string[] = [];
  const record = requireRecord(value, "session meta", errors);
  if (record) {
    requireSchemaVersion(record, errors);
    requireSessionId(record, "sessionId", errors);
    requireDate(record, "date", errors);
    requireNonEmptyString(record, "timezone", errors);
    requireNonEmptyString(record, "createdAt", errors);
    requireOneOf(record, "repoKind", ["daily_session"], errors);
    requireNonEmptyString(record, "agentId", errors);
  }
  return validationResult(value, errors);
}

export function validateGitMemoryConversationRecord(value: unknown): ValidationResult<GitMemoryConversationRecord> {
  const errors: string[] = [];
  const record = requireRecord(value, "conversation record", errors);
  if (record) {
    requirePositiveInteger(record, "seq", errors);
    rejectFields(record, ["v", "messageId", "turnId"], errors);
    requireOneOf(record, "role", ["user", "assistant", "system"], errors);
    requireNonEmptyString(record, "at", errors);
    requireInlineOrReferencedContent(record, errors);
    requireOptionalTaskId(record, "taskId", errors);
    requireOptionalRunId(record, "runId", errors);
    requireOptionalNonEmptyString(record, "branch", errors);
  }
  return validationResult(value, errors);
}

export function validateGitMemoryTaskStateFile(value: unknown): ValidationResult<GitMemoryTaskStateFile> {
  const errors: string[] = [];
  const record = requireRecord(value, "task state", errors);
  if (record) {
    requireSchemaVersion(record, errors);
    requireTaskStatus(record, errors);
    requireNonEmptyString(record, "summary", errors);
    requireOptionalNonEmptyString(record, "sessionStoreCommit", errors);
    requireStringArray(record, "completed", errors);
    requireStringArray(record, "open", errors);
    requireStringArray(record, "blockers", errors);
    requireStringArray(record, "facts", errors);
    requireNonEmptyString(record, "next", errors);
    requireNonEmptyString(record, "updatedAt", errors);
  }
  return validationResult(value, errors);
}

export function validateGitMemoryRunFile(value: unknown): ValidationResult<GitMemoryRunFile> {
  const errors: string[] = [];
  const record = requireRecord(value, "run file", errors);
  if (record) {
    requireSchemaVersion(record, errors);
    requireRunId(record, "runId", errors);
    requireTaskId(record, "taskId", errors);
    requireOneOf(record, "status", ["completed", "failed", "blocked", "needs_user_input"], errors);
    requireNonEmptyString(record, "startedAt", errors);
    requireOptionalNonEmptyString(record, "completedAt", errors);
    const refs = requireArray(record, "conversationRefs", errors);
    if (refs) {
      refs.forEach((ref, index) => {
        const refRecord = requireRecord(ref, `conversationRefs[${index}]`, errors);
        if (refRecord) requireConversationSeqRange(refRecord, errors);
      });
    }
    requireNonEmptyString(record, "summary", errors);
    requireOptionalNonEmptyString(record, "intent", errors);
    requireOptionalNonEmptyString(record, "routing", errors);
    requireOptionalNonEmptyString(record, "outcome", errors);
    requireOptionalStringArray(record, "workPerformed", errors);
    requireOptionalStringArray(record, "verification", errors);
    requireOptionalStringArray(record, "decisions", errors);
    requireOptionalStringArray(record, "blockers", errors);
    requireOptionalNonEmptyString(record, "assistantResponse", errors);
    requireNonNegativeInteger(record, "toolCallCount", errors);
    requireStringArray(record, "changedFiles", errors);
    requireStringArray(record, "newFacts", errors);
    requireOptionalNonEmptyString(record, "next", errors);
  }
  return validationResult(value, errors);
}

export function validateGitMemoryActionRecord(value: unknown): ValidationResult<GitMemoryActionRecord> {
  const errors: string[] = [];
  const record = requireRecord(value, "action record", errors);
  if (record) {
    requireVersion(record, errors);
    requireActionId(record, "actionId", errors);
    requireRunId(record, "runId", errors);
    requireNonEmptyString(record, "tool", errors);
    requireOneOf(record, "status", ["completed", "failed", "skipped"], errors);
    requireNonEmptyString(record, "summary", errors);
    requireNonEmptyString(record, "startedAt", errors);
    requireOptionalNonEmptyString(record, "completedAt", errors);
    requireOptionalNonEmptyString(record, "evidenceRef", errors);
  }
  return validationResult(value, errors);
}

export function validateGitMemoryEvidenceManifestRecord(
  value: unknown,
): ValidationResult<GitMemoryEvidenceManifestRecord> {
  const errors: string[] = [];
  const record = requireRecord(value, "evidence manifest record", errors);
  if (record) {
    requireVersion(record, errors);
    requireRunId(record, "runId", errors);
    requireTaskId(record, "taskId", errors);
    requireOptionalPositiveInteger(record, "step", errors);
    requireOptionalActionId(record, "actionId", errors);
    requireNonEmptyString(record, "tool", errors);
    requireOptionalOneOf(record, "status", ["completed", "failed", "skipped"], errors);
    requireNonEmptyString(record, "summary", errors);
    requireOptionalNonEmptyString(record, "evidenceRef", errors);
    requireStringArray(record, "artifacts", errors);
    requireStringArray(record, "facts", errors);
    requireStringArray(record, "accessModes", errors);
    requireOptionalNonNegativeInteger(record, "outputSize", errors);
    requireOptionalNonNegativeInteger(record, "lineCount", errors);
    requireOptionalBoolean(record, "truncated", errors);
    requireOptionalRecord(record, "source", errors);
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
  if (record["schemaVersion"] !== GIT_MEMORY_SCHEMA_VERSION) {
    errors.push("schemaVersion must be 1.");
  }
}

function requireVersion(record: Record<string, unknown>, errors: string[]): void {
  if (record["v"] !== GIT_MEMORY_SCHEMA_VERSION) {
    errors.push("v must be 1.");
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

function rejectFields(record: Record<string, unknown>, fields: string[], errors: string[]): void {
  for (const field of fields) {
    if (field in record) {
      errors.push(`${field} is not supported in conversation debug records.`);
    }
  }
}

function requireOptionalNonEmptyString(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return;
  }
  if (value.trim().length === 0) {
    errors.push(`${field} must not be empty.`);
  }
}

function requireOptionalBoolean(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "boolean") {
    errors.push(`${field} must be a boolean.`);
  }
}

function requireOptionalRecord(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${field} must be an object.`);
  }
}

function requirePositiveInteger(record: Record<string, unknown>, field: string, errors: string[]): number | undefined {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    errors.push(`${field} must be a positive integer.`);
    return undefined;
  }
  return value;
}

function requireOptionalPositiveInteger(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    errors.push(`${field} must be a positive integer.`);
  }
}

function requireNonNegativeInteger(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    errors.push(`${field} must be a non-negative integer.`);
  }
}

function requireOptionalNonNegativeInteger(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    errors.push(`${field} must be a non-negative integer.`);
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

function requireOptionalOneOf<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  errors: string[],
): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(`${field} must be one of: ${allowed.join(", ")}.`);
  }
}

function requireArray(record: Record<string, unknown>, field: string, errors: string[]): unknown[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array.`);
    return undefined;
  }
  return value;
}

function requireStringArray(record: Record<string, unknown>, field: string, errors: string[]): void {
  const values = requireArray(record, field, errors);
  if (!values) {
    return;
  }
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`${field}[${index}] must be a non-empty string.`);
    }
  });
}

function requireOptionalStringArray(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  requireStringArray(record, field, errors);
}

function requireDate(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isValidCalendarDate(value)) {
    errors.push(`${field} must be a valid date.`);
  }
}

function requireInlineOrReferencedContent(record: Record<string, unknown>, errors: string[]): void {
  const text = record["text"];
  const contentRef = record["contentRef"];
  const hasText = typeof text === "string" && text.trim().length > 0;
  const hasContentRef = typeof contentRef === "string" && contentRef.trim().length > 0;

  if (text !== undefined && text !== null && typeof text !== "string") {
    errors.push("text must be a string or null.");
  }
  if (contentRef !== undefined && contentRef !== null && typeof contentRef !== "string") {
    errors.push("contentRef must be a string or null.");
  }
  if (!hasText && !hasContentRef) {
    errors.push("conversation record must include non-empty text or contentRef.");
  }
  requireOptionalNonEmptyString(record, "sha256", errors);
}

function requireConversationSeqRange(record: Record<string, unknown>, errors: string[]): void {
  const fromSeq = requirePositiveInteger(record, "fromSeq", errors);
  const toSeq = requirePositiveInteger(record, "toSeq", errors);
  if (fromSeq !== undefined && toSeq !== undefined && toSeq < fromSeq) {
    errors.push("toSeq must be greater than or equal to fromSeq.");
  }
}

function requireSessionId(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isGitMemorySessionId(value)) {
    errors.push(`${field} must be a valid git-memory session id.`);
  }
}

function requireTaskId(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isGitMemoryTaskId(value)) {
    errors.push(`${field} must be a valid git-memory task id.`);
  }
}

function requireRunId(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isGitMemoryRunId(value)) {
    errors.push(`${field} must be a valid git-memory run id.`);
  }
}

function requireActionId(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = requireNonEmptyString(record, field, errors);
  if (value && !isGitMemoryActionId(value)) {
    errors.push(`${field} must be a valid git-memory action id.`);
  }
}

function requireOptionalTaskId(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return;
  }
  if (!isGitMemoryTaskId(value)) {
    errors.push(`${field} must be a valid git-memory task id.`);
  }
}

function requireOptionalRunId(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return;
  }
  if (!isGitMemoryRunId(value)) {
    errors.push(`${field} must be a valid git-memory run id.`);
  }
}

function requireOptionalActionId(record: Record<string, unknown>, field: string, errors: string[]): void {
  const value = record[field];
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return;
  }
  if (!isGitMemoryActionId(value)) {
    errors.push(`${field} must be a valid git-memory action id.`);
  }
}

function requireTaskStatus(record: Record<string, unknown>, errors: string[]): void {
  requireOneOf(record, "status", ["open", "in_progress", "blocked", "done", "abandoned"], errors);
}

function slugifyIdPart(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return normalized || fallback;
}

function formatSequence(sequence: number, width: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`Sequence must be a positive integer: ${String(sequence)}`);
  }
  return String(sequence).padStart(width, "0");
}

function isValidCompactDate(value: string): boolean {
  return /^\d{8}$/.test(value)
    && isValidCalendarDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
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
