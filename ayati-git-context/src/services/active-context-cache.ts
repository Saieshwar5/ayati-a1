import { createHash } from "node:crypto";
import type {
  ActiveContext,
  ConversationContext,
  ReadContextProjection,
  ResourceRef,
  RunContextProjection,
  SessionResourcesProjection,
  WorkstreamCandidate,
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
  resources?: SessionResourcesProjection;
  ingressResources?: ResourceRef[];
  workstreamCandidates: WorkstreamCandidate[];
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
    resources: input.resources
      ? {
          count: input.resources.count,
          updatedAt: input.resources.updatedAt ?? null,
          recent: input.resources.recent.map((resource) => ({
            resourceId: resource.resourceId,
            availability: resource.availability,
            versionKey: resource.version.key,
            updatedAt: resource.updatedAt,
          })),
        }
      : null,
    ingressResources: (input.ingressResources ?? []).map((resource) => ({
      resourceId: resource.resourceId,
      availability: resource.availability,
      versionKey: resource.version.key,
      updatedAt: resource.updatedAt,
    })),
    run: input.run
      ? {
          runId: input.run.run.runId,
          workstreamBinding: input.run.run.workstreamBinding ?? null,
          status: input.run.run.status,
          stepCount: input.run.run.stepCount,
          workStateRevision: input.run.workState.revision,
          afterStep: input.run.workState.afterStep,
          updatedAt: input.run.workState.updatedAt,
        }
      : null,
    workstreamCandidates: input.workstreamCandidates.map((workstream) => ({
      workstreamId: workstream.workstreamId,
      status: workstream.status,
      lifecycleStatus: workstream.lifecycleStatus ?? null,
      repositoryHealth: workstream.repositoryHealth ?? null,
      currentRequest: workstream.currentRequest ?? null,
      discovery: workstream.discovery,
      starred: workstream.starred,
      lastOpenedAt: workstream.lastOpenedAt ?? null,
      boundRunsLast30Days: workstream.boundRunsLast30Days,
      head: workstream.head,
      updatedAt: workstream.updatedAt,
    })),
  }));
  return { revision, pendingDigest };
}

function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
