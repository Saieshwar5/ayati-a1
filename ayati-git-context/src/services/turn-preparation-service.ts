import type {
  EnsureActiveSessionResponse,
  PrepareContextTurnRequest,
  RunWorkStateInput,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { beginRecoverableIdempotent } from "../database/idempotency.js";
import { appendConversationMessage } from "../repositories/conversation-records.js";
import { createRun } from "../repositories/run-records.js";
import {
  createPreparedContextTurnReceipt,
  type PreparedContextTurnReceipt,
} from "./prepared-context-turn-receipt.js";

/** Owns the one transaction that accepts an ingress turn and creates its run. */
export class TurnPreparationService {
  constructor(private readonly database: ContextDatabase) {}

  prepare(input: PrepareContextTurnRequest, options: {
    ensureSession: () => EnsureActiveSessionResponse;
    admitResources?: (input: { messageId: string; runId: string }) => void;
  }): ReturnType<typeof beginRecoverableIdempotent<PreparedContextTurnReceipt>> {
    return beginRecoverableIdempotent<PreparedContextTurnReceipt>({
      database: this.database,
      requestId: input.requestId,
      operation: "prepare_context_turn",
      payload: input,
      now: input.at,
      execute: () => {
        const ensured = options.ensureSession();
        const appended = appendConversationMessage(this.database, {
          sessionId: ensured.session.sessionId,
          role: input.role,
          content: input.content,
          at: input.at,
        });
        const run = createRun(this.database, {
          sessionId: ensured.session.sessionId,
          conversationId: appended.conversation.conversationId,
          trigger: input.role,
          workState: initialWorkState(),
          at: input.at,
        });
        options.admitResources?.({
          messageId: appended.message.messageId,
          runId: run.runId,
        });
        return createPreparedContextTurnReceipt({
          sessionId: ensured.session.sessionId,
          sessionCreated: ensured.created,
          conversationId: appended.conversation.conversationId,
          messageId: appended.message.messageId,
          runId: run.runId,
        });
      },
    });
  }
}

function initialWorkState(): RunWorkStateInput {
  return {
    status: "not_done",
    summary: "Run started.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}
