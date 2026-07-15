import { createHash } from "node:crypto";
import type {
  ActiveContext,
  ConversationContext,
  ReadContextProjection,
  RunContextProjection,
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

  clear(): void {
    this.entries.clear();
  }
}

export function activeContextRevision(input: {
  head: string | null;
  status: string;
  conversations: ConversationContext[];
  readContext?: ReadContextProjection;
  run?: RunContextProjection;
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
    run: input.run
      ? {
          runId: input.run.run.runId,
          runClass: input.run.run.runClass,
          taskId: input.run.run.taskId,
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
      head: task.head,
      updatedAt: task.updatedAt,
    })),
  }));
  return { revision, pendingDigest };
}

function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
