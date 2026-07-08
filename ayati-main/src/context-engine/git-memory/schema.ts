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
export type GitMemoryConversationKind = "message" | "feedback_question";
export type GitMemoryTaskStatus = "open" | "in_progress" | "needs_user_input" | "blocked" | "done" | "abandoned";
export type GitMemoryRunStatus = "completed" | "failed" | "blocked" | "needs_user_input";
export type GitMemorySessionRunStatus = GitMemoryRunStatus | "running" | "promoted";
export type GitMemoryActionStatus = "completed" | "failed" | "skipped";
export type GitMemoryTaskFactConfidence = "verified" | "observed" | "assumed";
export type GitMemoryTaskFileRole = "created" | "modified" | "touched" | "reference" | "generated";
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
  strategy?: "deterministic" | "llm";
  coveredUntilSeq?: number;
  messageCount?: number;
  sourceFromSeq?: number;
  sourceToSeq?: number;
  previousCoveredUntilSeq?: number;
}

export type GitMemorySessionAttachmentStatus = "ready" | "partial" | "failed" | "unsupported";

export interface GitMemorySessionAttachmentRecord {
  sessionAssetId: string;
  kind: string;
  name: string;
  source: string;
  status: GitMemorySessionAttachmentStatus;
  documentId?: string;
  fileId?: string;
  directoryId?: string;
  originalPath?: string;
  storedPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  checksum?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface GitMemorySessionAttachmentsFile {
  schemaVersion: 1;
  sessionId: GitMemorySessionId;
  updatedAt: string;
  attachments: GitMemorySessionAttachmentRecord[];
}

export interface GitMemorySessionRunPromotion {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
}

export interface GitMemorySessionRunFile {
  schemaVersion: 1;
  sessionId: GitMemorySessionId;
  runId: GitMemoryRunId;
  runClass: "session";
  status: GitMemorySessionRunStatus;
  startedAt: string;
  completedAt?: string;
  triggerSeq?: number;
  conversationRefs: GitMemoryConversationSeqRange[];
  summary: string;
  intent?: string;
  routing?: string;
  outcome?: string;
  workPerformed?: string[];
  verification?: string[];
  decisions?: string[];
  assistantResponse?: string;
  toolCallCount: number;
  toolsUsed: string[];
  changedFiles: string[];
  newFacts: string[];
  workState?: unknown;
  promotedTo?: GitMemorySessionRunPromotion;
  blockers?: string[];
  next?: string;
}

export interface GitMemoryConversationRecord {
  seq: number;
  role: GitMemoryConversationRole;
  kind?: GitMemoryConversationKind;
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

export interface GitMemoryTaskStateFact {
  text: string;
  sourceRunId?: GitMemoryRunId;
  sourceStep?: number;
  confidence: GitMemoryTaskFactConfidence;
}

export interface GitMemoryTaskStateDecision {
  text: string;
  sourceRunId?: GitMemoryRunId;
}

export interface GitMemoryTaskStateEvidence {
  summary: string;
  sourceRunId?: GitMemoryRunId;
  sourceStep?: number;
  artifacts: string[];
  facts: string[];
}

export type GitMemoryTaskArtifactSource = "user_attachment" | "agent_workspace";
export type GitMemoryTaskArtifactStatus = "active" | "deleted" | "renamed" | "superseded";
export type GitMemoryTaskArtifactConfidence = "user_provided" | "verified" | "inferred";

export interface GitMemoryTaskArtifactIdentity {
  name: string;
  type: string;
  description: string;
  aliases: string[];
}

export interface GitMemoryTaskStateFileRecord {
  artifactId: string;
  source: GitMemoryTaskArtifactSource;
  kind: string;
  path: string;
  originalName?: string;
  mimeType?: string;
  role: GitMemoryTaskFileRole;
  identity: GitMemoryTaskArtifactIdentity;
  status: GitMemoryTaskArtifactStatus;
  reason?: string;
  createdByRunId?: GitMemoryRunId;
  lastTouchedRunId?: GitMemoryRunId;
  sourceRunId?: GitMemoryRunId;
  sourceTurnSeq?: number;
  confidence: GitMemoryTaskArtifactConfidence;
}

export interface GitMemoryTaskStateRunSummary {
  runId: GitMemoryRunId;
  status: GitMemoryRunStatus;
  summary: string;
  outcome?: string;
  completedAt?: string;
  changedFiles: string[];
  next?: string;
}

export interface GitMemoryTaskStateFile {
  schemaVersion: 2;
  task: {
    taskId: GitMemoryTaskId;
    title: string;
    objective: string;
    branch: string;
    createdAt: string;
    updatedAt: string;
  };
  status: GitMemoryTaskStatus;
  summary: string;
  progress: {
    completed: string[];
    open: string[];
    blockers: string[];
    next: string;
  };
  memory: {
    facts: GitMemoryTaskStateFact[];
    decisions: GitMemoryTaskStateDecision[];
    evidence: GitMemoryTaskStateEvidence[];
    files: GitMemoryTaskStateFileRecord[];
    assets: TaskAssetRecord[];
  };
  runs: {
    latestRunId?: GitMemoryRunId;
    runIds: GitMemoryRunId[];
    recent: GitMemoryTaskStateRunSummary[];
  };
  context: {
    workingSummary: string;
    importantFiles: string[];
    searchTerms: string[];
    warnings: string[];
  };
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

export type GitMemoryStepStatus = "completed" | "failed" | "skipped";

export interface GitMemoryStepToolCallRecord {
  callId?: string;
  tool: string;
  status: "success" | "failed";
  startedAt?: string;
  completedAt?: string;
  input: unknown;
  output?: string;
  rawOutputChars?: number;
  outputTruncated?: boolean;
  error?: string;
  code?: string;
  operationStatus?: string;
  meta?: Record<string, unknown>;
  result?: unknown;
  artifacts?: unknown[];
  verifiedFacts?: unknown[];
  assertionResults?: unknown[];
  observation?: unknown;
}

export interface GitMemoryStepVerificationRecord {
  passed: boolean;
  policy?: string;
  method?: string;
  executionStatus?: string;
  validationStatus?: string;
  summary: string;
  evidenceSummary?: string;
  evidenceItems: string[];
  newFacts: string[];
  artifacts: string[];
  usedRawArtifacts: string[];
  expectationCheckStatus?: string;
  expectationCheckSummary?: string;
}

export interface GitMemoryStepRecord {
  v: 1;
  runId: GitMemoryRunId;
  taskId: GitMemoryTaskId;
  step: number;
  status: GitMemoryStepStatus;
  startedAt?: string;
  completedAt: string;
  summary: string;
  decision?: Record<string, unknown>;
  action?: Record<string, unknown>;
  toolCalls: GitMemoryStepToolCallRecord[];
  verification: GitMemoryStepVerificationRecord;
  workStateAfter?: unknown;
  facts: string[];
  artifacts: string[];
  outputSize?: number;
  lineCount?: number;
  truncated?: boolean;
  failureType?: string;
  blockedTargets?: string[];
}

export interface GitMemorySessionStepRecord {
  v: 1;
  sessionId: GitMemorySessionId;
  runId: GitMemoryRunId;
  step: number;
  status: GitMemoryStepStatus;
  startedAt?: string;
  completedAt: string;
  summary: string;
  decision?: Record<string, unknown>;
  action?: Record<string, unknown>;
  toolCalls: GitMemoryStepToolCallRecord[];
  verification: GitMemoryStepVerificationRecord;
  workStateAfter?: unknown;
  facts: string[];
  artifacts: string[];
  outputSize?: number;
  lineCount?: number;
  truncated?: boolean;
  failureType?: string;
  blockedTargets?: string[];
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function gitMemoryTaskDir(taskId: GitMemoryTaskId): string {
  return `tasks/${taskId}`;
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

export function gitMemoryTaskStepsPath(taskId: GitMemoryTaskId, runId: GitMemoryRunId): string {
  return `${gitMemoryTaskDir(taskId)}/steps/${runId}.jsonl`;
}

export function gitMemoryTaskStepsStagingPath(taskId: GitMemoryTaskId, runId: GitMemoryRunId): string {
  return `${gitMemoryTaskStepsPath(taskId, runId)}.tmp`;
}

export function gitMemoryTaskAssetsPath(taskId: GitMemoryTaskId): string {
  return `${gitMemoryTaskDir(taskId)}/assets.json`;
}

export function gitMemoryTaskNotesPath(taskId: GitMemoryTaskId): string {
  return `${gitMemoryTaskDir(taskId)}/notes.md`;
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

export function gitMemorySessionStoreMetaPath(sessionId: GitMemorySessionId): string {
  return `${gitMemorySessionStoreSessionDir(sessionId)}/meta.json`;
}

export function gitMemorySessionStoreSchemaPath(sessionId: GitMemorySessionId): string {
  return `${gitMemorySessionStoreSessionDir(sessionId)}/schema.json`;
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

export function gitMemorySessionStoreAttachmentsPath(sessionId: GitMemorySessionId): string {
  return `${gitMemorySessionStoreSessionDir(sessionId)}/attachments/index.json`;
}

export function gitMemorySessionStoreRunsDir(sessionId: GitMemorySessionId): string {
  return `${gitMemorySessionStoreSessionDir(sessionId)}/runs`;
}

export function gitMemorySessionStoreRunPath(sessionId: GitMemorySessionId, runId: GitMemoryRunId): string {
  if (!isGitMemoryRunId(runId)) {
    throw new Error(`Invalid git-memory run id: ${runId}`);
  }
  return `${gitMemorySessionStoreRunsDir(sessionId)}/${runId}.json`;
}

export function gitMemorySessionStoreRunMarkdownPath(sessionId: GitMemorySessionId, runId: GitMemoryRunId): string {
  if (!isGitMemoryRunId(runId)) {
    throw new Error(`Invalid git-memory run id: ${runId}`);
  }
  return `${gitMemorySessionStoreRunsDir(sessionId)}/${runId}.md`;
}

export function gitMemorySessionStoreStepsDir(sessionId: GitMemorySessionId): string {
  return `${gitMemorySessionStoreSessionDir(sessionId)}/steps`;
}

export function gitMemorySessionStoreStepsPath(sessionId: GitMemorySessionId, runId: GitMemoryRunId): string {
  if (!isGitMemoryRunId(runId)) {
    throw new Error(`Invalid git-memory run id: ${runId}`);
  }
  return `${gitMemorySessionStoreStepsDir(sessionId)}/${runId}.jsonl`;
}

export function gitMemorySessionStoreActiveRunDir(sessionId: GitMemorySessionId, runId: GitMemoryRunId): string {
  if (!isGitMemoryRunId(runId)) {
    throw new Error(`Invalid git-memory run id: ${runId}`);
  }
  return `${gitMemorySessionStoreSessionDir(sessionId)}/active-runs/${runId}`;
}

export function gitMemorySessionStoreActiveRunPath(sessionId: GitMemorySessionId, runId: GitMemoryRunId): string {
  return `${gitMemorySessionStoreActiveRunDir(sessionId, runId)}/run.json`;
}

export function gitMemorySessionStoreActiveRunStepsPath(sessionId: GitMemorySessionId, runId: GitMemoryRunId): string {
  return `${gitMemorySessionStoreActiveRunDir(sessionId, runId)}/steps.jsonl`;
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
    requireOptionalOneOf(record, "kind", ["message", "feedback_question"], errors);
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
    requireExactSchemaVersion(record, 2, errors);
    const task = requireRecord(record["task"], "task", errors);
    if (task) {
      requireTaskId(task, "taskId", errors);
      requireNonEmptyString(task, "title", errors);
      requireNonEmptyString(task, "objective", errors);
      requireNonEmptyString(task, "branch", errors);
      requireNonEmptyString(task, "createdAt", errors);
      requireNonEmptyString(task, "updatedAt", errors);
    }
    requireTaskStatus(record, errors);
    requireNonEmptyString(record, "summary", errors);
    const progress = requireRecord(record["progress"], "progress", errors);
    if (progress) {
      requireStringArray(progress, "completed", errors);
      requireStringArray(progress, "open", errors);
      requireStringArray(progress, "blockers", errors);
      requireNonEmptyString(progress, "next", errors);
    }
    const memory = requireRecord(record["memory"], "memory", errors);
    if (memory) {
      validateTaskStateFacts(memory["facts"], errors);
      validateTaskStateDecisions(memory["decisions"], errors);
      validateTaskStateEvidence(memory["evidence"], errors);
      validateTaskStateFiles(memory["files"], errors);
      requireArray(memory, "assets", errors);
    }
    const runs = requireRecord(record["runs"], "runs", errors);
    if (runs) {
      requireOptionalRunId(runs, "latestRunId", errors);
      validateRunIdArray(runs["runIds"], "runIds", errors);
      validateTaskStateRunSummaries(runs["recent"], errors);
    }
    const context = requireRecord(record["context"], "context", errors);
    if (context) {
      requireNonEmptyString(context, "workingSummary", errors);
      requireStringArray(context, "importantFiles", errors);
      requireStringArray(context, "searchTerms", errors);
      requireStringArray(context, "warnings", errors);
    }
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

function requireExactSchemaVersion(record: Record<string, unknown>, version: number, errors: string[]): void {
  if (record["schemaVersion"] !== version) {
    errors.push(`schemaVersion must be ${version}.`);
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

function validateRunIdArray(value: unknown, field: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array.`);
    return;
  }
  value.forEach((item, index) => {
    if (!isGitMemoryRunId(item)) {
      errors.push(`${field}[${index}] must be a valid git-memory run id.`);
    }
  });
}

function validateTaskStateFacts(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("facts must be an array.");
    return;
  }
  value.forEach((item, index) => {
    const fact = requireRecord(item, `facts[${index}]`, errors);
    if (!fact) return;
    requireNonEmptyString(fact, "text", errors);
    requireOptionalRunId(fact, "sourceRunId", errors);
    requireOptionalPositiveInteger(fact, "sourceStep", errors);
    requireOneOf(fact, "confidence", ["verified", "observed", "assumed"], errors);
  });
}

function validateTaskStateDecisions(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("decisions must be an array.");
    return;
  }
  value.forEach((item, index) => {
    const decision = requireRecord(item, `decisions[${index}]`, errors);
    if (!decision) return;
    requireNonEmptyString(decision, "text", errors);
    requireOptionalRunId(decision, "sourceRunId", errors);
  });
}

function validateTaskStateEvidence(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("evidence must be an array.");
    return;
  }
  value.forEach((item, index) => {
    const evidence = requireRecord(item, `evidence[${index}]`, errors);
    if (!evidence) return;
    requireNonEmptyString(evidence, "summary", errors);
    requireOptionalRunId(evidence, "sourceRunId", errors);
    requireOptionalPositiveInteger(evidence, "sourceStep", errors);
    requireStringArray(evidence, "artifacts", errors);
    requireStringArray(evidence, "facts", errors);
  });
}

function validateTaskStateFiles(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("files must be an array.");
    return;
  }
  value.forEach((item, index) => {
    const file = requireRecord(item, `files[${index}]`, errors);
    if (!file) return;
    requireNonEmptyString(file, "artifactId", errors);
    requireOneOf(file, "source", ["user_attachment", "agent_workspace"], errors);
    requireNonEmptyString(file, "kind", errors);
    requireNonEmptyString(file, "path", errors);
    requireOptionalNonEmptyString(file, "originalName", errors);
    requireOptionalNonEmptyString(file, "mimeType", errors);
    requireOneOf(file, "role", ["created", "modified", "touched", "reference", "generated"], errors);
    const identity = requireRecord(file["identity"], `files[${index}].identity`, errors);
    if (identity) {
      requireNonEmptyString(identity, "name", errors);
      requireNonEmptyString(identity, "type", errors);
      requireNonEmptyString(identity, "description", errors);
      requireStringArray(identity, "aliases", errors);
    }
    requireOneOf(file, "status", ["active", "deleted", "renamed", "superseded"], errors);
    requireOptionalNonEmptyString(file, "reason", errors);
    requireOptionalRunId(file, "createdByRunId", errors);
    requireOptionalRunId(file, "lastTouchedRunId", errors);
    requireOptionalRunId(file, "sourceRunId", errors);
    requireOptionalPositiveInteger(file, "sourceTurnSeq", errors);
    requireOneOf(file, "confidence", ["user_provided", "verified", "inferred"], errors);
  });
}

function validateTaskStateRunSummaries(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("recent must be an array.");
    return;
  }
  value.forEach((item, index) => {
    const run = requireRecord(item, `recent[${index}]`, errors);
    if (!run) return;
    requireRunId(run, "runId", errors);
    requireOneOf(run, "status", ["completed", "failed", "blocked", "needs_user_input"], errors);
    requireNonEmptyString(run, "summary", errors);
    requireOptionalNonEmptyString(run, "outcome", errors);
    requireOptionalNonEmptyString(run, "completedAt", errors);
    requireStringArray(run, "changedFiles", errors);
    requireOptionalNonEmptyString(run, "next", errors);
  });
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
  requireOneOf(record, "status", ["open", "in_progress", "needs_user_input", "blocked", "done", "abandoned"], errors);
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
