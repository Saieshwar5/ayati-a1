import type { ContextDatabase } from "../database/database.js";

export interface FileSyncRecord {
  operationId: string;
  requestId: string;
  sessionId: string;
  conversationId: string;
  sourcePath?: string;
  targetPath: string;
}

export function readPendingFileSyncs(
  database: ContextDatabase,
  requestId?: string,
): FileSyncRecord[] {
  const where = requestId
    ? "WHERE status != 'completed' AND request_id = ?"
    : "WHERE status != 'completed'";
  const statement = database.prepare([
    "SELECT operation_id, request_id, session_id, conversation_id, source_path, target_path",
    "FROM file_sync_operations",
    where,
    "ORDER BY created_at, operation_id",
  ].join(" "));
  const rows = (requestId ? statement.all(requestId) : statement.all()) as unknown as Array<{
    operation_id: string;
    request_id: string;
    session_id: string;
    conversation_id: string;
    source_path: string | null;
    target_path: string;
  }>;
  return rows.map((row) => ({
    operationId: row.operation_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    ...(row.source_path ? { sourcePath: row.source_path } : {}),
    targetPath: row.target_path,
  }));
}

export function completeFileSync(
  database: ContextDatabase,
  operationId: string,
  contentHash: string,
  at: string,
): void {
  database.prepare([
    "UPDATE file_sync_operations",
    "SET status = 'completed', expected_content_hash = ?, completed_at = ?, last_error = NULL",
    "WHERE operation_id = ?",
  ].join(" ")).run(contentHash, at, operationId);
}

export function failFileSync(
  database: ContextDatabase,
  operationId: string,
  error: string,
): void {
  database.prepare([
    "UPDATE file_sync_operations SET status = 'failed', last_error = ?",
    "WHERE operation_id = ?",
  ].join(" ")).run(error, operationId);
}
