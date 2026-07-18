import { ActiveContextCache } from "./active-context-cache.js";
import { ActiveContextDataCache } from "./active-context-data-cache.js";
import { GitContextServiceObservability } from "./service-observability.js";

export interface ContextInvalidationInput {
  sessionId?: string;
  runId?: string;
  taskId?: string;
  allSessions?: boolean;
  readContext?: boolean;
  attachments?: boolean;
  taskCandidates?: boolean;
}

export class ActiveContextInvalidation {
  constructor(private readonly options: {
    contextCache: ActiveContextCache;
    dataCache: ActiveContextDataCache;
    events: GitContextServiceObservability;
  }) {}

  invalidate(reason: string, input: ContextInvalidationInput): void {
    if (input.readContext && input.sessionId) {
      this.options.dataCache.invalidateReadContext(input.sessionId);
    }
    if (input.attachments && input.sessionId) {
      this.options.dataCache.invalidateAttachments(input.sessionId);
    }
    if (input.taskCandidates) {
      this.options.dataCache.invalidateTaskCandidates();
    }
    const previousRevision = input.sessionId
      ? this.options.contextCache.latestRevision(input.sessionId)
      : undefined;
    const scope = input.allSessions || !input.sessionId ? "all" : "session";
    const invalidatedEntries = scope === "all"
      ? this.options.contextCache.clear()
      : this.options.contextCache.invalidate(input.sessionId!);
    this.options.events.cacheInvalidated(reason, {
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      previousRevision,
      scope,
      invalidatedEntries,
    });
  }
}
