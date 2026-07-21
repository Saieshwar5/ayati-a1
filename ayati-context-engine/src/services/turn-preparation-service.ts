import type {
  AgentStreamRef,
  PrepareAgentRunRequest,
  RunWorkStateInput,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { beginRecoverableIdempotent } from "../database/idempotency.js";
import { appendStreamMessage } from "../repositories/message-records.js";
import { createRun } from "../repositories/run-records.js";
import type { PreparedAgentRunReceipt } from "./prepared-agent-run-receipt.js";

/** Owns the one transaction that accepts an ingress turn and creates its run. */
export class TurnPreparationService {
  constructor(private readonly database: ContextDatabase) {}

  prepare(input: PrepareAgentRunRequest, options: {
    ensureStream: () => { stream: AgentStreamRef; created: boolean };
    admitResources?: (input: { messageId: string; runId: string }) => void;
  }): ReturnType<typeof beginRecoverableIdempotent<PreparedAgentRunReceipt>> {
    return beginRecoverableIdempotent<PreparedAgentRunReceipt>({
      database: this.database,
      requestId: input.requestId,
      operation: "prepare_agent_run",
      payload: input,
      now: input.at,
      execute: () => {
        const ensured = options.ensureStream();
        const run = createRun(this.database, {
          streamId: ensured.stream.streamId,
          trigger: input.role,
          workState: initialWorkState(),
          at: input.at,
        });
        const message = appendStreamMessage(this.database, {
          streamId: ensured.stream.streamId,
          runId: run.runId,
          role: input.role,
          content: input.content,
          at: input.at,
        });
        options.admitResources?.({
          messageId: message.messageId,
          runId: run.runId,
        });
        return {
          v: 1,
          kind: "prepared_agent_run",
          streamId: ensured.stream.streamId,
          streamCreated: ensured.created,
          messageId: message.messageId,
          runId: run.runId,
        };
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
