import type {
  ActiveContext,
  CommitSummary,
  RunContextProjection,
  SessionRef,
  WorkstreamContextProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import type { SessionRecord } from "../repositories/session-records.js";
import { readRunResources } from "../repositories/resource-records.js";
import { ActiveContextCache, activeContextRevision } from "./active-context-cache.js";
import type { ActiveContextDataCache } from "./active-context-data-cache.js";
import type { ConversationHotCache } from "./conversation-hot-cache.js";
import type { GitContextServiceObservability } from "./service-observability.js";
import type { SessionRegistryCache } from "./session-registry-cache.js";

interface SessionSummary {
  summary: string;
  recentCommits: CommitSummary[];
}

export class ActiveContextProjectionService {
  constructor(private readonly options: {
    database: ContextDatabase;
    sessionRegistry: SessionRegistryCache;
    conversationCache: ConversationHotCache;
    contextDataCache: ActiveContextDataCache;
    contextCache: ActiveContextCache;
    events: GitContextServiceObservability;
    loadSessionSummary: (session: SessionRef) => Promise<SessionSummary>;
    loadActiveRun: (sessionId: string) => RunContextProjection | undefined;
    loadActiveWorkstream: (
      sessionId: string,
      run: RunContextProjection,
    ) => Promise<WorkstreamContextProjection | undefined>;
  }) {}

  unavailable(): ActiveContext {
    return {
      contextRevision: activeContextRevision({
        head: null,
        status: "unavailable",
        conversations: [],
        workstreamCandidates: [],
      }).revision,
      session: null,
      warnings: [],
    };
  }

  async build(sessionRecord: SessionRecord): Promise<ActiveContext> {
    const startedAt = Date.now();
    const session = this.options.sessionRegistry.toRef(sessionRecord);
    const sessionSummary = await this.options.loadSessionSummary(session);
    const run = this.options.loadActiveRun(session.sessionId);
    const conversations = this.options.conversationCache.getPendingContexts(
      this.options.database,
      session.sessionId,
    );
    const latestInput = [...conversations]
      .reverse()
      .flatMap((conversation) => [...conversation.messages].reverse())
      .find((message) => message.role !== "assistant");
    const workstreamCandidates = await this.options.contextDataCache.workstreamCandidates({
      limit: 20,
      sessionId: session.sessionId,
      ...(latestInput ? { currentText: latestInput.content } : {}),
    });
    const readContext = this.options.contextDataCache.readContext(session.sessionId);
    const resources = this.options.contextDataCache.resources(session.sessionId);
    const ingressResources = run ? readRunResources(this.options.database, run.run.runId) : [];
    const { revision, pendingDigest } = activeContextRevision({
      head: session.head,
      status: session.status,
      conversations,
      readContext,
      ...(resources ? { resources } : {}),
      ...(run ? { run } : {}),
      ...(ingressResources.length > 0 ? { ingressResources } : {}),
      workstreamCandidates,
    });
    const cached = this.options.contextCache.get(session.sessionId, revision);
    if (cached) {
      this.options.events.cacheHit(session.sessionId, revision);
      return cached;
    }

    const previousRevision = this.options.contextCache.latestRevision(session.sessionId);
    this.options.events.cacheMiss(session.sessionId, revision, previousRevision);
    const activeWorkstream = run
      ? await this.options.loadActiveWorkstream(session.sessionId, run)
      : undefined;
    const context: ActiveContext = {
      contextRevision: revision,
      session: {
        session,
        summary: sessionSummary.summary,
        pendingConversation: this.options.conversationCache.getPendingConversations(
          this.options.database,
          session.sessionId,
        ),
        pendingConversationContext: conversations,
        pendingDigest,
        recentCommits: sessionSummary.recentCommits,
        ...(resources ? { resources } : {}),
      },
      ...(run ? { run } : {}),
      ...(ingressResources.length > 0 ? { ingressResources } : {}),
      ...(activeWorkstream ? { activeWorkstream } : {}),
      readContext,
      workstreamCandidates,
      warnings: [],
    };
    this.options.contextCache.set(session.sessionId, revision, context);
    this.options.events.cacheBuilt(context, Date.now() - startedAt, previousRevision);
    return context;
  }
}
