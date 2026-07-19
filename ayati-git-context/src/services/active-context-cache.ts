import { createHash } from "node:crypto";
import type {
  ActiveContext,
  ConversationContext,
  ReadContextProjection,
  RunContextProjection,
  SessionAttachmentsProjection,
  TaskCandidate,
} from "../contracts.js";

export class ActiveContextCache {
  private readonly entries = new Map<string, ActiveContext>();

  get(sessionId: string, revision: string): ActiveContext | undefined {
    return this.entries.get(sessionId + ":" + revision);
  }

  set(sessionId: string, revision: string, context: ActiveContext): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(sessionId + ":")) {
        this.entries.delete(key);
      }
    }
    this.entries.set(sessionId + ":" + revision, context);
  }

  latestRevision(sessionId: string): string | undefined {
    const prefix = sessionId + ":";
    return [...this.entries.keys()].find((key) => key.startsWith(prefix))?.slice(prefix.length);
  }

  latest(sessionId: string): ActiveContext | undefined {
    const prefix = sessionId + ":";
    const entry = [...this.entries.entries()].find(([key]) => key.startsWith(prefix));
    return entry?.[1];
  }

  invalidate(sessionId: string): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(sessionId + ":")) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): number {
    const removed = this.entries.size;
    this.entries.clear();
    return removed;
  }
}

export function activeContextRevision(input: {
  head: string | null;
  status: string;
  conversations: ConversationContext[];
  readContext?: ReadContextProjection;
  run?: RunContextProjection;
  attachments?: SessionAttachmentsProjection;
  taskCandidates: TaskCandidate[];
}): { revision: string; pendingDigest: string } {
  const pendingDigest = hash(JSON.stringify(input.conversations.map((item) => ({
    id: item.conversation.conversationId,
    path: item.conversation.filePath,
    status: item.conversation.status,
    hash: item.contentHash,
  }))));
  const revision = hash(JSON.stringify({
    head: input.head,
    status: input.status,
    pendingDigest,
    readContextRevision: input.readContext?.revision ?? null,
    attachments: input.attachments
      ? {
          count: input.attachments.count,
          updatedAt: input.attachments.updatedAt ?? null,
          recent: input.attachments.recent.map((attachment) => ({
            sessionAssetId: attachment.sessionAssetId,
            status: attachment.status,
            checksum: attachment.checksum ?? null,
            lastUsedAt: attachment.lastUsedAt ?? null,
          })),
        }
      : null,
    run: input.run
      ? {
          runId: input.run.run.runId,
          taskBinding: input.run.run.taskBinding ?? null,
          status: input.run.run.status,
          stepCount: input.run.run.stepCount,
          workStateRevision: input.run.workState.revision,
          afterStep: input.run.workState.afterStep,
          updatedAt: input.run.workState.updatedAt,
        }
      : null,
    taskCandidates: input.taskCandidates.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      lifecycleStatus: task.lifecycleStatus ?? null,
      repositoryHealth: task.repositoryHealth ?? null,
      currentRequest: task.currentRequest ?? null,
      discovery: task.discovery,
      starred: task.starred,
      lastOpenedAt: task.lastOpenedAt ?? null,
      boundRunsLast30Days: task.boundRunsLast30Days,
      head: task.head,
      updatedAt: task.updatedAt,
    })),
  }));
  return { revision, pendingDigest };
}

function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
