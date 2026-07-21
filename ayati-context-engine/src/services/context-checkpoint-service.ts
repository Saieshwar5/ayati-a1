import { createHash } from "node:crypto";
import type {
  CommitContextCheckpointRequest,
  ContextCheckpointPlan,
  ContextCheckpointRecord,
  ContextCheckpointSummary,
  PlanContextCheckpointRequest,
  StreamMessage,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import { readAgentStream, setActiveCheckpoint } from "../repositories/agent-stream-records.js";
import {
  contextCheckpointSourceHash,
  insertContextCheckpoint,
  readActiveContextCheckpoint,
} from "../repositories/context-checkpoint-records.js";
import {
  readRecentStreamMessages,
  readStreamMessages,
} from "../repositories/message-records.js";

const DEFAULT_CHECKPOINT_TOKENS = 1_200;
const MAX_SOURCE_MESSAGES = 2_000;
const PLAN_TAIL_MESSAGES = 200;
const SUMMARY_KEYS = [
  "userRequests",
  "constraints",
  "decisions",
  "corrections",
  "importantFacts",
  "unresolvedQuestions",
  "references",
] as const;

export class ContextCheckpointService {
  constructor(private readonly database: ContextDatabase) {}

  plan(input: PlanContextCheckpointRequest): ContextCheckpointPlan {
    const stream = readAgentStream(this.database, input.streamId);
    if (!stream) throw streamNotFound(input.streamId);
    const previousCheckpoint = readActiveContextCheckpoint(this.database, input.streamId);
    const firstUncoveredSeq = (previousCheckpoint?.coveredToSeq ?? 0) + 1;
    const estimatedCheckpointTokens = clampCheckpointTokens(
      input.estimatedCheckpointTokens ?? DEFAULT_CHECKPOINT_TOKENS,
    );
    if (input.protectFromSeq <= firstUncoveredSeq) {
      return idlePlan(input, previousCheckpoint, estimatedCheckpointTokens, []);
    }

    const candidates = readStreamMessages(this.database, {
      streamId: input.streamId,
      fromSeq: firstUncoveredSeq,
      toSeq: input.protectFromSeq - 1,
      limit: MAX_SOURCE_MESSAGES,
    });
    const selectedMessages = this.completeTerminalPrefix(candidates, input.protectFromSeq);
    const estimatedSavings = estimateMessageTokens(selectedMessages) - estimatedCheckpointTokens;
    if (selectedMessages.length === 0 || estimatedSavings < input.requiredSavingsTokens) {
      return idlePlan(input, previousCheckpoint, estimatedCheckpointTokens, candidates);
    }

    const coveredFromSeq = previousCheckpoint?.coveredFromSeq
      ?? selectedMessages[0]!.sequence;
    const coveredToSeq = selectedMessages.at(-1)!.sequence;
    const sourceHash = contextCheckpointSourceHash({
      ...(previousCheckpoint ? { previousCheckpoint } : {}),
      messages: selectedMessages,
    });
    const exactTail = readRecentStreamMessages(this.database, {
      streamId: input.streamId,
      afterSeq: coveredToSeq,
      limit: PLAN_TAIL_MESSAGES,
    });
    return {
      planId: planIdentity({
        streamId: input.streamId,
        coveredToSeq,
        sourceHash,
        protectFromSeq: input.protectFromSeq,
        requiredSavingsTokens: input.requiredSavingsTokens,
        estimatedCheckpointTokens,
      }),
      streamId: input.streamId,
      ...(previousCheckpoint ? { previousCheckpoint } : {}),
      selectedMessages,
      exactTail,
      coveredFromSeq,
      coveredToSeq,
      sourceHash,
      estimatedCheckpointTokens,
      triggered: true,
    };
  }

  /** Must run inside the caller's idempotency transaction. */
  commit(input: CommitContextCheckpointRequest): ContextCheckpointRecord {
    if (!input.plan.triggered
      || input.plan.coveredFromSeq === undefined
      || input.plan.coveredToSeq === undefined
      || !input.plan.sourceHash) {
      throw new ContextEngineServiceError({
        code: "CHECKPOINT_NOT_REQUIRED",
        message: "The checkpoint plan did not select a pressure-driven source range.",
      });
    }
    const stream = readAgentStream(this.database, input.plan.streamId);
    if (!stream) throw streamNotFound(input.plan.streamId);
    const active = readActiveContextCheckpoint(this.database, input.plan.streamId);
    const expectedPreviousId = input.plan.previousCheckpoint?.checkpointId;
    if (active?.checkpointId !== expectedPreviousId
      || stream.activeCheckpointId !== expectedPreviousId) {
      throw sourceChanged(input.plan.streamId, "The active checkpoint changed after planning.");
    }

    const firstNewSeq = (active?.coveredToSeq ?? 0) + 1;
    const messages = readStreamMessages(this.database, {
      streamId: input.plan.streamId,
      fromSeq: firstNewSeq,
      toSeq: input.plan.coveredToSeq,
      limit: MAX_SOURCE_MESSAGES,
    });
    if (messages.length === 0 || messages.at(-1)?.sequence !== input.plan.coveredToSeq) {
      throw sourceChanged(input.plan.streamId, "The selected message range is no longer complete.");
    }
    const sourceHash = contextCheckpointSourceHash({
      ...(active ? { previousCheckpoint: active } : {}),
      messages,
    });
    if (sourceHash !== input.plan.sourceHash) {
      throw sourceChanged(input.plan.streamId, "The exact checkpoint source changed after planning.");
    }
    this.validateSummary(input.summary, {
      streamId: input.plan.streamId,
      coveredFromSeq: input.plan.coveredFromSeq,
      coveredToSeq: input.plan.coveredToSeq,
      tokenCount: input.tokenCount,
      estimatedCheckpointTokens: input.plan.estimatedCheckpointTokens,
    });
    const exactAnchors = checkpointAnchors(input.summary);
    const checkpoint = insertContextCheckpoint(this.database, {
      streamId: input.plan.streamId,
      ...(active ? { previousCheckpointId: active.checkpointId } : {}),
      coveredFromSeq: input.plan.coveredFromSeq,
      coveredToSeq: input.plan.coveredToSeq,
      sourceHash,
      summary: input.summary,
      exactAnchors,
      tokenCount: input.tokenCount,
      provider: input.provider,
      model: input.model,
      at: input.at,
    });
    setActiveCheckpoint(
      this.database,
      input.plan.streamId,
      checkpoint.checkpointId,
      active?.checkpointId,
      input.at,
    );
    return checkpoint;
  }

  private completeTerminalPrefix(
    candidates: StreamMessage[],
    protectFromSeq: number,
  ): StreamMessage[] {
    const selected: StreamMessage[] = [];
    let index = 0;
    while (index < candidates.length) {
      const runId = candidates[index]!.runId;
      const group: StreamMessage[] = [];
      while (index < candidates.length && candidates[index]!.runId === runId) {
        group.push(candidates[index]!);
        index += 1;
      }
      const run = this.database.prepare([
        "SELECT status FROM runs WHERE run_id = ?",
      ].join(" ")).get(runId) as { status: string } | undefined;
      const last = this.database.prepare([
        "SELECT MAX(sequence) AS sequence FROM messages WHERE run_id = ?",
      ].join(" ")).get(runId) as { sequence: number | null };
      const terminal = run && run.status !== "running" && run.status !== "recovery_required";
      const complete = last.sequence !== null
        && Number(last.sequence) === group.at(-1)?.sequence
        && Number(last.sequence) < protectFromSeq;
      if (!terminal || !complete) break;
      selected.push(...group);
    }
    return selected;
  }

  private validateSummary(summary: ContextCheckpointSummary, input: {
    streamId: string;
    coveredFromSeq: number;
    coveredToSeq: number;
    tokenCount: number;
    estimatedCheckpointTokens: number;
  }): void {
    const statements = SUMMARY_KEYS.flatMap((key) => summary[key]);
    if (summary.narrative.trim().length === 0 || summary.narrative.length > 8_000
      || statements.some((statement) => statement.text.trim().length === 0
        || statement.text.length > 2_000)
      || SUMMARY_KEYS.some((key) => summary[key].length > 64)) {
      throw invalidCheckpoint("Checkpoint summary does not satisfy the bounded V1 schema.");
    }
    const estimatedTextTokens = estimateTextTokens([
      summary.narrative,
      ...statements.map((statement) => statement.text),
    ].join("\n"));
    const maximumTokens = Math.min(4_000, Math.max(input.estimatedCheckpointTokens * 2, 1_600));
    if (input.tokenCount <= 0 || input.tokenCount > maximumTokens
      || estimatedTextTokens > Math.ceil(input.tokenCount * 1.25)) {
      throw invalidCheckpoint("Checkpoint summary exceeds its validated token budget.");
    }
    for (const statement of statements) {
      if (!Number.isSafeInteger(statement.seq)
        || statement.seq < input.coveredFromSeq
        || statement.seq > input.coveredToSeq
        || !this.messageSequenceExists(input.streamId, statement.seq)) {
        throw invalidCheckpoint("Every checkpoint statement must anchor to an exact source message.", {
          sequence: statement.seq,
        });
      }
    }
  }

  private messageSequenceExists(streamId: string, sequence: number): boolean {
    const row = this.database.prepare([
      "SELECT 1 AS present FROM messages WHERE stream_id = ? AND sequence = ?",
    ].join(" ")).get(streamId, sequence) as { present: number } | undefined;
    return Boolean(row);
  }
}

function idlePlan(
  input: PlanContextCheckpointRequest,
  previousCheckpoint: ContextCheckpointRecord | undefined,
  estimatedCheckpointTokens: number,
  candidateTail: StreamMessage[],
): ContextCheckpointPlan {
  return {
    planId: planIdentity({
      streamId: input.streamId,
      coveredToSeq: previousCheckpoint?.coveredToSeq ?? 0,
      sourceHash: previousCheckpoint?.sourceHash ?? "none",
      protectFromSeq: input.protectFromSeq,
      requiredSavingsTokens: input.requiredSavingsTokens,
      estimatedCheckpointTokens,
    }),
    streamId: input.streamId,
    ...(previousCheckpoint ? { previousCheckpoint } : {}),
    selectedMessages: [],
    exactTail: candidateTail.slice(-PLAN_TAIL_MESSAGES),
    estimatedCheckpointTokens,
    triggered: false,
  };
}

function checkpointAnchors(summary: ContextCheckpointSummary): number[] {
  return [...new Set(SUMMARY_KEYS.flatMap((key) => summary[key].map((entry) => entry.seq)))]
    .sort((left, right) => left - right);
}

function clampCheckpointTokens(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 200), 4_000);
}

function estimateMessageTokens(messages: StreamMessage[]): number {
  return messages.reduce((total, message) => total + estimateTextTokens(message.content) + 12, 0);
}

function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function planIdentity(input: {
  streamId: string;
  coveredToSeq: number;
  sourceHash: string;
  protectFromSeq: number;
  requiredSavingsTokens: number;
  estimatedCheckpointTokens: number;
}): string {
  return "CPPLAN-" + createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
}

function streamNotFound(streamId: string): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "AGENT_STREAM_NOT_FOUND",
    message: "Agent stream does not exist.",
    details: { streamId },
  });
}

function sourceChanged(streamId: string, message: string): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "CHECKPOINT_SOURCE_CHANGED",
    message,
    retryable: true,
    details: { streamId },
  });
}

function invalidCheckpoint(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "CHECKPOINT_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
