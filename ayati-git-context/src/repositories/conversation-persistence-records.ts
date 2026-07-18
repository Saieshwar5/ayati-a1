import type { ConversationPersistenceState } from "../contracts.js";
import {
  deriveConversationPersistenceState,
  type ConversationMaterializationEvidence,
} from "../conversations/conversation-persistence-state.js";
import type { ContextDatabase } from "../database/database.js";

interface ConversationPersistenceRow {
  file_path: string;
  content_hash: string | null;
  committed_sha: string | null;
  sync_status: ConversationMaterializationEvidence["status"] | null;
  sync_target_path: string | null;
  sync_content_hash: string | null;
}

export function readConversationPersistenceState(
  database: ContextDatabase,
  conversationId: string,
): ConversationPersistenceState | undefined {
  const row = database.prepare([
    "SELECT conversation.file_path, conversation.content_hash, conversation.committed_sha,",
    "sync.status AS sync_status, sync.target_path AS sync_target_path,",
    "sync.expected_content_hash AS sync_content_hash",
    "FROM conversation_segments conversation",
    "LEFT JOIN file_sync_operations sync ON sync.operation_id = (",
    "  SELECT candidate.operation_id FROM file_sync_operations candidate",
    "  WHERE candidate.conversation_id = conversation.conversation_id",
    "  ORDER BY candidate.created_at DESC, candidate.operation_id DESC LIMIT 1",
    ")",
    "WHERE conversation.conversation_id = ?",
    "AND EXISTS (",
    "  SELECT 1 FROM messages message",
    "  WHERE message.conversation_id = conversation.conversation_id",
    ")",
  ].join(" ")).get(conversationId) as ConversationPersistenceRow | undefined;
  if (!row) return undefined;

  return deriveConversationPersistenceState({
    plannedPath: row.file_path,
    ...(row.content_hash ? { contentHash: row.content_hash } : {}),
    ...(row.committed_sha ? { committedSha: row.committed_sha } : {}),
    ...(row.sync_status && row.sync_target_path
      ? {
          materialization: {
            status: row.sync_status,
            targetPath: row.sync_target_path,
            ...(row.sync_content_hash ? { contentHash: row.sync_content_hash } : {}),
          },
        }
      : {}),
  });
}
