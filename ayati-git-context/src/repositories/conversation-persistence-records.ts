import type { ConversationPersistenceState } from "../contracts.js";
import { deriveConversationPersistenceState } from "../conversations/conversation-persistence-state.js";
import type { ContextDatabase } from "../database/database.js";

interface ConversationPersistenceRow {
  file_path: string;
  content_hash: string | null;
  committed_sha: string | null;
}

export function readConversationPersistenceState(
  database: ContextDatabase,
  conversationId: string,
): ConversationPersistenceState | undefined {
  const row = database.prepare([
    "SELECT conversation.file_path, conversation.content_hash, conversation.committed_sha",
    "FROM conversation_segments conversation",
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
  });
}
