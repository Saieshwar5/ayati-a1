import { rm } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { ContextDatabase } from "../database/database.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import {
  readConversation,
  readConversationMessages,
  updateConversationContentHash,
} from "../repositories/conversation-records.js";
import {
  completeFileSync,
  failFileSync,
  readPendingFileSyncs,
} from "../repositories/file-sync-records.js";
import { readSession } from "../repositories/session-records.js";
import { conversationContentHash, renderConversation } from "./conversation-renderer.js";

export async function synchronizePendingConversationFiles(input: {
  database: ContextDatabase;
  now: () => string;
  requestId?: string;
}): Promise<void> {
  const operations = readPendingFileSyncs(input.database, input.requestId);
  for (const operation of operations) {
    try {
      const session = readSession(input.database, operation.sessionId);
      const conversation = readConversation(input.database, operation.conversationId);
      if (!session || !conversation) {
        throw new Error("File sync references missing session or conversation state.");
      }
      const content = renderConversation(
        conversation,
        readConversationMessages(input.database, conversation.conversationId),
      );
      const contentHash = conversationContentHash(content);
      const target = safeRepositoryPath(session.repositoryPath, operation.targetPath);
      await writeFileAtomically(target, content);
      if (operation.sourcePath && operation.sourcePath !== operation.targetPath) {
        await rm(safeRepositoryPath(session.repositoryPath, operation.sourcePath), {
          force: true,
        });
      }
      input.database.transaction(() => {
        updateConversationContentHash(
          input.database,
          conversation.conversationId,
          contentHash,
        );
        completeFileSync(input.database, operation.operationId, contentHash, input.now());
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failFileSync(input.database, operation.operationId, message);
      throw error;
    }
  }
  completeRecoveredRequests(input.database, input.now());
}

function completeRecoveredRequests(database: ContextDatabase, at: string): void {
  database.prepare([
    "UPDATE idempotency_requests",
    "SET status = 'completed', completed_at = COALESCE(completed_at, ?)",
    "WHERE operation = 'append_conversation'",
    "AND status != 'completed'",
    "AND EXISTS (",
    "  SELECT 1 FROM file_sync_operations sync",
    "  WHERE sync.request_id = idempotency_requests.request_id",
    ")",
    "AND NOT EXISTS (",
    "  SELECT 1 FROM file_sync_operations sync",
    "  WHERE sync.request_id = idempotency_requests.request_id",
    "  AND sync.status != 'completed'",
    ")",
  ].join(" ")).run(at);
}

function safeRepositoryPath(repositoryPath: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    throw new Error("Conversation file path must be repository-relative.");
  }
  const normalized = normalize(filePath);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("..\\")) {
    throw new Error("Conversation file path escapes the session repository.");
  }
  const target = join(repositoryPath, normalized);
  if (relative(repositoryPath, target).startsWith("..")) {
    throw new Error("Conversation file path escapes the session repository.");
  }
  return target;
}
