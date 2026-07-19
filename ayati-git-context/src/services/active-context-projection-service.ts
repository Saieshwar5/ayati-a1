import type {
  ActiveContext,
  CommitSummary,
  RunContextProjection,
  SessionRef,
  TaskContextProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import type { SessionRecord } from "../repositories/session-records.js";
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
    loadActiveTask: (
      sessionId: string,
      run: RunContextProjection,
    ) => Promise<TaskContextProjection | undefined>;
  }) {}

  unavailable(): ActiveContext {
    return {
      contextRevision: activeContextRevision({
        head: null,
        status: "unavailable",
        conversations: [],
        taskCandidates: [],
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
    const taskCandidates = await this.options.contextDataCache.taskCandidates({
      limit: 20,
      sessionId: session.sessionId,
      ...(latestInput ? { currentText: latestInput.content } : {}),
    });
    const readContext = this.options.contextDataCache.readContext(session.sessionId);
    const attachments = this.options.contextDataCache.attachments(session.sessionId);
    const { revision, pendingDigest } = activeContextRevision({
      head: session.head,
      status: session.status,
      conversations,
      readContext,
      ...(attachments ? { attachments } : {}),
      ...(run ? { run } : {}),
      taskCandidates,
    });
    const cached = this.options.contextCache.get(session.sessionId, revision);
    if (cached) {
      this.options.events.cacheHit(session.sessionId, revision);
      return cached;
    }

    const previousRevision = this.options.contextCache.latestRevision(session.sessionId);
    this.options.events.cacheMiss(session.sessionId, revision, previousRevision);
    const activeTask = run
      ? await this.options.loadActiveTask(session.sessionId, run)
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
        ...(attachments ? { attachments } : {}),
      },
      ...(run ? { run } : {}),
      ...(activeTask ? { activeTask } : {}),
      readContext,
      taskCandidates,
      warnings: [],
    };
    this.options.contextCache.set(session.sessionId, revision, context);
    this.options.events.cacheBuilt(context, Date.now() - startedAt, previousRevision);
    return context;
  }
}
