import type {
  BoundTaskReference,
  SessionAttachmentRecord,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import type { TaskReference } from "../tasks/task-references.js";

export type TaskAttachmentBindingPhase =
  | "placed"
  | "committed"
  | "recovery_required";

export interface TaskAttachmentBindingRecord {
  taskId: string;
  sessionAssetId: string;
  referenceId: string;
  runId: string;
  taskRequestId: string;
  conversationId: string;
  reference: TaskReference;
  phase: TaskAttachmentBindingPhase;
  commitHead?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

interface SessionAttachmentRow {
  attachment_json: string;
}

interface BindingRow {
  task_id: string;
  session_asset_id: string;
  reference_id: string;
  run_id: string;
  task_request_id: string;
  conversation_id: string;
  reference_json: string;
  phase: TaskAttachmentBindingPhase;
  commit_head: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export function upsertSessionAttachments(database: ContextDatabase, input: {
  sessionId: string;
  conversationId: string;
  attachments: SessionAttachmentRecord[];
  at: string;
}): void {
  const statement = database.prepare([
    "INSERT INTO session_attachments(",
    "conversation_id, session_asset_id, session_id, attachment_json, created_at, updated_at",
    ") VALUES (?, ?, ?, ?, ?, ?)",
    "ON CONFLICT(conversation_id, session_asset_id) DO UPDATE SET",
    "attachment_json = excluded.attachment_json, updated_at = excluded.updated_at",
  ].join(" "));
  for (const attachment of input.attachments) {
    statement.run(
      input.conversationId,
      attachment.sessionAssetId,
      input.sessionId,
      JSON.stringify(attachment),
      input.at,
      input.at,
    );
  }
}

export function readConversationAttachments(
  database: ContextDatabase,
  sessionId: string,
  conversationId: string,
): SessionAttachmentRecord[] {
  const rows = database.prepare([
    "SELECT attachment_json FROM session_attachments",
    "WHERE session_id = ? AND conversation_id = ?",
    "ORDER BY created_at, session_asset_id",
  ].join(" ")).all(sessionId, conversationId) as unknown as SessionAttachmentRow[];
  return rows.map((row) => JSON.parse(row.attachment_json) as SessionAttachmentRecord);
}

export function readRecentSessionAttachments(
  database: ContextDatabase,
  sessionId: string,
  limit = 20,
): SessionAttachmentRecord[] {
  const rows = database.prepare([
    "SELECT attachment_json FROM session_attachments",
    "WHERE session_id = ? ORDER BY updated_at DESC, session_asset_id LIMIT ?",
  ].join(" ")).all(sessionId, limit * 4) as unknown as SessionAttachmentRow[];
  const seen = new Set<string>();
  const result: SessionAttachmentRecord[] = [];
  for (const row of rows) {
    const attachment = JSON.parse(row.attachment_json) as SessionAttachmentRecord;
    if (seen.has(attachment.sessionAssetId)) continue;
    seen.add(attachment.sessionAssetId);
    result.push(attachment);
    if (result.length === limit) break;
  }
  return result;
}

export function countSessionAttachments(
  database: ContextDatabase,
  sessionId: string,
): number {
  const row = database.prepare([
    "SELECT COUNT(DISTINCT session_asset_id) AS count FROM session_attachments",
    "WHERE session_id = ?",
  ].join(" ")).get(sessionId) as { count: number };
  return Number(row.count);
}

export function upsertTaskAttachmentBinding(database: ContextDatabase, input: {
  taskId: string;
  sessionAssetId: string;
  referenceId: string;
  runId: string;
  taskRequestId: string;
  conversationId: string;
  reference: TaskReference;
  at: string;
}): TaskAttachmentBindingRecord {
  database.prepare([
    "INSERT INTO task_attachment_bindings(",
    "task_id, session_asset_id, reference_id, run_id, task_request_id, conversation_id,",
    "reference_json, phase, commit_head, created_at, updated_at, last_error",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, 'placed', NULL, ?, ?, NULL)",
    "ON CONFLICT(task_id, session_asset_id) DO UPDATE SET",
    "run_id = excluded.run_id, task_request_id = excluded.task_request_id,",
    "conversation_id = excluded.conversation_id, reference_json = excluded.reference_json,",
    "phase = 'placed', commit_head = NULL, updated_at = excluded.updated_at, last_error = NULL",
  ].join(" ")).run(
    input.taskId,
    input.sessionAssetId,
    input.referenceId,
    input.runId,
    input.taskRequestId,
    input.conversationId,
    JSON.stringify(input.reference),
    input.at,
    input.at,
  );
  return requireTaskAttachmentBinding(database, input.taskId, input.sessionAssetId);
}

export function readTaskAttachmentBinding(
  database: ContextDatabase,
  taskId: string,
  sessionAssetId: string,
): TaskAttachmentBindingRecord | undefined {
  const row = database.prepare(selectBindings() + " WHERE task_id = ? AND session_asset_id = ?")
    .get(taskId, sessionAssetId) as BindingRow | undefined;
  return row ? binding(row) : undefined;
}

export function readTaskAttachmentBindingByReference(
  database: ContextDatabase,
  taskId: string,
  referenceId: string,
): TaskAttachmentBindingRecord | undefined {
  const row = database.prepare(selectBindings() + " WHERE task_id = ? AND reference_id = ?")
    .get(taskId, referenceId) as BindingRow | undefined;
  return row ? binding(row) : undefined;
}

export function readRunTaskAttachmentBindings(
  database: ContextDatabase,
  runId: string,
): TaskAttachmentBindingRecord[] {
  const rows = database.prepare(
    selectBindings() + " WHERE run_id = ? ORDER BY reference_id",
  ).all(runId) as unknown as BindingRow[];
  return rows.map(binding);
}

export function readTaskAttachmentBindings(
  database: ContextDatabase,
  taskId: string,
): TaskAttachmentBindingRecord[] {
  const rows = database.prepare(
    selectBindings() + " WHERE task_id = ? ORDER BY reference_id",
  ).all(taskId) as unknown as BindingRow[];
  return rows.map(binding);
}

export function updateTaskAttachmentReference(database: ContextDatabase, input: {
  taskId: string;
  sessionAssetId: string;
  runId: string;
  taskRequestId: string;
  reference: TaskReference;
  at: string;
}): TaskAttachmentBindingRecord {
  database.prepare([
    "UPDATE task_attachment_bindings SET run_id = ?, task_request_id = ?,",
    "reference_json = ?, phase = 'placed', commit_head = NULL, updated_at = ?,",
    "last_error = NULL WHERE task_id = ? AND session_asset_id = ?",
  ].join(" ")).run(
    input.runId,
    input.taskRequestId,
    JSON.stringify(input.reference),
    input.at,
    input.taskId,
    input.sessionAssetId,
  );
  return requireTaskAttachmentBinding(database, input.taskId, input.sessionAssetId);
}

export function markRunTaskAttachmentsCommitted(
  database: ContextDatabase,
  runId: string,
  commitHead: string,
  at: string,
): void {
  database.prepare([
    "UPDATE task_attachment_bindings SET phase = 'committed', commit_head = ?,",
    "updated_at = ?, last_error = NULL WHERE run_id = ? AND phase != 'committed'",
  ].join(" ")).run(commitHead, at, runId);
}

export function markRunTaskAttachmentsRecoveryRequired(
  database: ContextDatabase,
  runId: string,
  error: string,
  at: string,
): void {
  database.prepare([
    "UPDATE task_attachment_bindings SET phase = 'recovery_required',",
    "updated_at = ?, last_error = ? WHERE run_id = ? AND phase != 'committed'",
  ].join(" ")).run(at, error, runId);
}

export function toBoundTaskReference(
  record: TaskAttachmentBindingRecord,
): BoundTaskReference {
  return {
    taskId: record.taskId,
    runId: record.runId,
    taskRequestId: record.taskRequestId,
    sessionAssetId: record.sessionAssetId,
    referenceId: record.referenceId,
    kind: record.reference.kind === "external_directory" ? "external_directory" : "attachment",
    location: record.reference.location,
    ...(record.reference.sha256 ? { sha256: record.reference.sha256 } : {}),
    availability: record.reference.availability,
    ...(record.reference.adoptedPath ? { adoptedPath: record.reference.adoptedPath } : {}),
  };
}

function requireTaskAttachmentBinding(
  database: ContextDatabase,
  taskId: string,
  sessionAssetId: string,
): TaskAttachmentBindingRecord {
  const record = readTaskAttachmentBinding(database, taskId, sessionAssetId);
  if (!record) throw new Error("Task attachment binding could not be read after persistence.");
  return record;
}

function selectBindings(): string {
  return [
    "SELECT task_id, session_asset_id, reference_id, run_id, task_request_id,",
    "conversation_id, reference_json, phase, commit_head, created_at, updated_at, last_error",
    "FROM task_attachment_bindings",
  ].join(" ");
}

function binding(row: BindingRow): TaskAttachmentBindingRecord {
  return {
    taskId: row.task_id,
    sessionAssetId: row.session_asset_id,
    referenceId: row.reference_id,
    runId: row.run_id,
    taskRequestId: row.task_request_id,
    conversationId: row.conversation_id,
    reference: JSON.parse(row.reference_json) as TaskReference,
    phase: row.phase,
    ...(row.commit_head ? { commitHead: row.commit_head } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
