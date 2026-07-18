import type {
  CompleteContextTurnRequest,
  CompleteContextTurnResponse,
  RunContextProjection,
  SessionAttachmentsProjection,
  SessionRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  hasRecoverableIdempotencyRequest,
  markRecoverableIdempotencyFailed,
  type RecoverableIdempotencyResult,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  appendConversationMessage,
  readConversation,
  readConversationBinding,
  readConversationMessage,
  readLatestConversationMessage,
} from "../repositories/conversation-records.js";
import { readConversationPersistenceState } from "../repositories/conversation-persistence-records.js";
import type { ActiveContextCache } from "./active-context-cache.js";
import { activeContextRevision } from "./active-context-cache.js";
import type { ActiveContextDataCache } from "./active-context-data-cache.js";
import {
  completeContextTurnReceipt,
  createCompletedContextTurnReceipt,
  requireCompletedContextTurnReceipt,
  type CompletedContextTurnReceipt,
} from "./completed-context-turn-receipt.js";
import type { ConversationHotCache } from "./conversation-hot-cache.js";
import type { GitContextServiceObservability } from "./service-observability.js";
import { verifyExpectedHead } from "./session-policy.js";

export class ContextTurnCompletionService {
  constructor(private readonly options: {
    database: ContextDatabase;
    contextCache: ActiveContextCache;
    contextDataCache: ActiveContextDataCache;
    conversationCache: ConversationHotCache;
    events: GitContextServiceObservability;
    requireSession: (sessionId: string) => SessionRef;
    requireWritableSession: (sessionId: string) => SessionRef;
    loadActiveRun: (sessionId: string) => RunContextProjection | undefined;
    invalidateContext: (reason: string, sessionId: string) => void;
  }) {}

  async complete(input: CompleteContextTurnRequest): Promise<CompleteContextTurnResponse> {
    const startedAt = Date.now();
    this.options.events.emit({
      level: "debug",
      event: "context_turn_completion_started",
      requestId: input.requestId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      outcome: "started",
    });
    let existingRequest: boolean;
    let pending: RecoverableIdempotencyResult<CompletedContextTurnReceipt>;
    try {
      existingRequest = hasRecoverableIdempotencyRequest({
        database: this.options.database,
        requestId: input.requestId,
        operation: "complete_context_turn",
        payload: input,
      });
      pending = beginRecoverableIdempotent<CompletedContextTurnReceipt>({
        database: this.options.database,
        requestId: input.requestId,
        operation: "complete_context_turn",
        payload: input,
        now: input.at,
        execute: () => this.persist(input),
      });
    } catch (error) {
      this.emitFailure(input, startedAt, error);
      throw error;
    }
    try {
      const receipt = requireCompletedContextTurnReceipt(pending.result);
      const session = this.options.requireSession(receipt.sessionId);
      const conversation = readConversation(this.options.database, receipt.conversationId);
      const message = readConversationMessage(
        this.options.database,
        receipt.assistantMessageId,
      );
      const persistence = readConversationPersistenceState(
        this.options.database,
        receipt.conversationId,
      );
      if (!conversation
        || conversation.sessionId !== receipt.sessionId
        || !message
        || message.conversationId !== receipt.conversationId
        || message.role !== "assistant"
        || !persistence) {
        throw new Error("Completed context turn receipt does not resolve to durable records.");
      }

      const previousContext = this.options.contextCache.latest(session.sessionId);
      let conversations;
      if (pending.completed || existingRequest) {
        conversations = this.options.conversationCache.refreshSession(
          this.options.database,
          session.sessionId,
        );
      } else {
        conversations = this.options.conversationCache.append(
          session.sessionId,
          conversation,
          message,
        );
        if (conversations.length === 0) {
          conversations = this.options.conversationCache.refreshSession(
            this.options.database,
            session.sessionId,
          );
        }
      }
      if (!pending.completed) {
        this.options.invalidateContext("assistant_message_persisted", session.sessionId);
      }

      const projection = await this.projectContextRevision(
        session,
        conversations,
        previousContext,
      );
      const result: CompleteContextTurnResponse = {
        conversation,
        message,
        persistence,
        contextRevision: projection.contextRevision,
        pendingDigest: projection.pendingDigest,
      };
      if (pending.completed) {
        this.options.events.emit({
          level: "debug",
          event: "context_turn_completion_replayed",
          requestId: input.requestId,
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          durationMs: Date.now() - startedAt,
          outcome: "succeeded",
          data: {
            storedContextRevision: receipt.contextRevision,
            contextRevision: result.contextRevision,
            conversationPersistence: result.persistence,
          },
        });
        return result;
      }

      completeRecoverableIdempotent({
        database: this.options.database,
        requestId: input.requestId,
        result: completeContextTurnReceipt(receipt, projection),
        now: input.at,
      });
      this.options.events.emit({
        level: "info",
        event: "assistant_message_persisted",
        requestId: input.requestId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        durationMs: Date.now() - startedAt,
        outcome: "succeeded",
        data: {
          messageId: message.messageId,
          contentBytes: Buffer.byteLength(input.assistantContent),
          contextRevision: result.contextRevision,
          cacheUpdateSource: previousContext?.session ? "incremental" : "derived_sources",
        },
      });
      this.options.events.emit({
        level: "info",
        event: "conversation_persisted",
        requestId: input.requestId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        outcome: "succeeded",
        data: {
          role: "assistant",
          conversationSequence: conversation.sequence,
          status: conversation.status,
          contentBytes: Buffer.byteLength(input.assistantContent),
          sourceOperation: "complete_context_turn",
          conversationPersistence: result.persistence,
        },
      });
      this.options.events.emit({
        level: "info",
        event: "context_turn_completion_completed",
        requestId: input.requestId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        durationMs: Date.now() - startedAt,
        outcome: "succeeded",
        data: {
          contextRevision: result.contextRevision,
          receiptBytes: Buffer.byteLength(JSON.stringify(
            completeContextTurnReceipt(receipt, projection),
          )),
        },
      });
      return result;
    } catch (error) {
      markRecoverableIdempotencyFailed({
        database: this.options.database,
        requestId: input.requestId,
      });
      this.emitFailure(input, startedAt, error);
      throw error;
    }
  }

  private persist(input: CompleteContextTurnRequest): CompletedContextTurnReceipt {
    const session = this.options.requireWritableSession(input.sessionId);
    verifyExpectedHead(session, input.expectedHead);
    const activeRun = this.options.loadActiveRun(input.sessionId);
    if (activeRun) {
      throw new GitContextServiceError({
        code: "RUN_ALREADY_ACTIVE",
        message: "Direct context-turn completion cannot finalize an active run.",
        details: { sessionId: input.sessionId, runId: activeRun.run.runId },
      });
    }
    const conversation = readConversation(this.options.database, input.conversationId);
    const binding = readConversationBinding(this.options.database, input.conversationId);
    const userMessage = readConversationMessage(this.options.database, input.userMessageId);
    const latestMessage = readLatestConversationMessage(
      this.options.database,
      input.conversationId,
    );
    if (!conversation
      || conversation.sessionId !== input.sessionId
      || conversation.status !== "active"
      || !binding
      || binding.runId
      || binding.taskId
      || !userMessage
      || userMessage.conversationId !== input.conversationId
      || userMessage.role === "assistant"
      || latestMessage?.messageId !== userMessage.messageId) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Direct context-turn completion requires an unbound active user conversation.",
        details: {
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          userMessageId: input.userMessageId,
        },
      });
    }
    const appended = appendConversationMessage(this.options.database, {
      requestId: input.requestId,
      sessionId: input.sessionId,
      role: "assistant",
      content: input.assistantContent,
      at: input.at,
    });
    if (appended.conversation.conversationId !== input.conversationId) {
      throw new Error("Assistant message was appended to the wrong conversation.");
    }
    return createCompletedContextTurnReceipt({
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      assistantMessageId: appended.message.messageId,
    });
  }

  private async projectContextRevision(
    session: SessionRef,
    conversations: ReturnType<ConversationHotCache["getPendingContexts"]>,
    previousContext: ReturnType<ActiveContextCache["latest"]>,
  ): Promise<{ contextRevision: string; pendingDigest: string }> {
    const readContext = previousContext
      ? previousContext.readContext
      : this.options.contextDataCache.readContext(session.sessionId);
    const attachments: SessionAttachmentsProjection | undefined = previousContext
      ? previousContext.session?.attachments
      : this.options.contextDataCache.attachments(session.sessionId);
    const run = previousContext
      ? previousContext.run
      : this.options.loadActiveRun(session.sessionId);
    const taskCandidates = previousContext
      ? previousContext.taskCandidates ?? []
      : await this.options.contextDataCache.taskCandidates(20);
    const revision = activeContextRevision({
      head: session.head,
      status: session.status,
      conversations,
      ...(readContext ? { readContext } : {}),
      ...(attachments ? { attachments } : {}),
      ...(run ? { run } : {}),
      taskCandidates,
    });
    if (previousContext?.session) {
      this.options.contextCache.set(session.sessionId, revision.revision, {
        ...previousContext,
        contextRevision: revision.revision,
        session: {
          ...previousContext.session,
          session,
          pendingConversation: conversations.map((item) => item.conversation),
          pendingConversationContext: conversations,
          pendingDigest: revision.pendingDigest,
        },
      });
    }
    return {
      contextRevision: revision.revision,
      pendingDigest: revision.pendingDigest,
    };
  }

  private emitFailure(
    input: CompleteContextTurnRequest,
    startedAt: number,
    error: unknown,
  ): void {
    this.options.events.emit({
      level: "error",
      event: "context_turn_completion_failed",
      requestId: input.requestId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      durationMs: Date.now() - startedAt,
      outcome: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
