import { createHash } from "node:crypto";
import type {
  AgentHistoryHit,
  ReadAgentHistoryRequest,
  ReadAgentHistoryResponse,
  RunStepToolCall,
  SearchAgentHistoryRequest,
  SearchAgentHistoryResponse,
  StreamMessage,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import { readAgentStream } from "../repositories/agent-stream-records.js";
import {
  readStreamMessage,
  readStreamMessages,
  searchStreamMessages,
} from "../repositories/message-records.js";
import {
  searchReusableObservations,
} from "../repositories/reusable-observation-records.js";
import {
  readRunEvidence,
  readRunStepEvidence,
} from "../repositories/run-records.js";
import { readRunWorkState } from "../repositories/run-work-state-records.js";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;
const DEFAULT_READ_CHARS = 32_000;
const MAX_READ_CHARS = 32_000;
const MAX_READ_MESSAGES = 50;

export class AgentHistoryService {
  constructor(private readonly database: ContextDatabase) {}

  search(input: SearchAgentHistoryRequest): SearchAgentHistoryResponse {
    this.requireStream(input.streamId);
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    const kinds = new Set(input.kinds ?? ["message", "run", "evidence"]);
    const hits: AgentHistoryHit[] = [];
    if (kinds.has("message")) {
      for (const message of searchStreamMessages(this.database, {
        streamId: input.streamId,
        query: input.query,
        limit,
      })) {
        hits.push({
          ref: "message:" + message.messageId,
          kind: "message",
          at: message.at,
          preview: preview(message.content),
          sequence: message.sequence,
          role: message.role,
          resourceIds: this.messageResourceIds(message.messageId),
        });
      }
    }
    if (kinds.has("run")) hits.push(...this.searchRuns(input.streamId, input.query, limit));
    if (kinds.has("evidence")) {
      for (const observation of searchReusableObservations(this.database, {
        streamId: input.streamId,
        query: input.query,
        limit,
      })) {
        hits.push({
          ref: observation.evidenceRef ?? "observation:" + observation.observationId,
          kind: "evidence",
          at: observation.createdAt,
          preview: observation.preview,
          ...(observation.workstreamId ? { workstreamId: observation.workstreamId } : {}),
          resourceIds: observation.resources.map((resource) => resource.resourceId),
        });
      }
    }
    return {
      hits: deduplicateHits(hits)
        .sort((left, right) => right.at.localeCompare(left.at) || left.ref.localeCompare(right.ref))
        .slice(0, limit),
    };
  }

  read(input: ReadAgentHistoryRequest): ReadAgentHistoryResponse {
    this.requireStream(input.streamId);
    const maxChars = Math.min(Math.max(input.maxChars ?? DEFAULT_READ_CHARS, 1), MAX_READ_CHARS);
    if ("fromSeq" in input) {
      if (input.toSeq < input.fromSeq) throw invalidRef("History sequence range is reversed.");
      const messages = readStreamMessages(this.database, {
        streamId: input.streamId,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        limit: MAX_READ_MESSAGES + 1,
      });
      return boundedMessages(messages, maxChars, input.toSeq);
    }
    return this.readRef(input.streamId, input.ref, input.offsetChars ?? 0, maxChars);
  }

  private readRef(
    streamId: string,
    ref: string,
    offsetChars: number,
    maxChars: number,
  ): ReadAgentHistoryResponse {
    if (ref.startsWith("message:")) {
      const messageId = ref.slice("message:".length);
      const message = readStreamMessage(this.database, messageId);
      if (!message || message.streamId !== streamId) throw invalidRef("Message history reference is unavailable.");
      return chunkSingleMessage(message, offsetChars, maxChars);
    }
    if (/^seq:\d+$/.test(ref)) {
      const sequence = Number(ref.slice("seq:".length));
      const message = readStreamMessages(this.database, {
        streamId,
        fromSeq: sequence,
        toSeq: sequence,
        limit: 1,
      })[0];
      if (!message) throw invalidRef("Message sequence is unavailable.");
      return chunkSingleMessage(message, offsetChars, maxChars);
    }
    const evidence = parseEvidenceRef(ref);
    if (evidence) {
      return this.readRunEvidenceChunk(streamId, ref, evidence.runId, {
        step: evidence.step,
        callId: evidence.callId,
      }, offsetChars, maxChars);
    }
    if (ref.startsWith("run:")) {
      const runId = ref.slice("run:".length);
      if (!runId || runId.includes(":")) throw invalidRef("Run history reference is invalid.");
      return this.readRunEvidenceChunk(streamId, ref, runId, undefined, offsetChars, maxChars);
    }
    throw invalidRef("Unknown agent-history reference.");
  }

  private readRunEvidenceChunk(
    streamId: string,
    ref: string,
    runId: string,
    selector: { step: number; callId: string } | undefined,
    offsetChars: number,
    maxChars: number,
  ): ReadAgentHistoryResponse {
    const run = readRunEvidence(this.database, runId);
    if (!run || run.streamId !== streamId) throw invalidRef("Run history reference is unavailable.");
    const steps = readRunStepEvidence(this.database, runId);
    let evidence: unknown;
    if (selector) {
      const step = steps.find((entry) => entry.step === selector.step);
      const call = step?.toolCalls.find((entry, index) =>
        (entry.callId ?? "call-" + String(index + 1).padStart(3, "0")) === selector.callId
      );
      if (!step || !call) throw invalidRef("Run evidence reference is unavailable.");
      evidence = { runId, step: selector.step, call: exactToolCall(call) };
    } else {
      evidence = {
        run,
        workState: readRunWorkState(this.database, runId),
        steps,
      };
    }
    const serialized = JSON.stringify(evidence);
    if (offsetChars > serialized.length) throw invalidRef("History evidence offset exceeds its content.");
    const content = serialized.slice(offsetChars, offsetChars + maxChars);
    const nextOffset = offsetChars + content.length;
    return {
      messages: [],
      evidence: {
        ref,
        content,
        offsetChars,
        totalChars: serialized.length,
        sha256: createHash("sha256").update(serialized).digest("hex"),
      },
      truncated: nextOffset < serialized.length,
      ...(nextOffset < serialized.length
        ? { continuationRef: ref, continuationOffsetChars: nextOffset }
        : {}),
    };
  }

  private searchRuns(streamId: string, query: string, limit: number): AgentHistoryHit[] {
    const terms = normalizedTerms(query);
    if (terms.length === 0) return [];
    const pattern = "%" + terms.join("%") + "%";
    const rows = this.database.prepare([
      "SELECT r.run_id, r.completed_at, r.started_at, r.status, r.workstream_id,",
      "ws.summary FROM runs r JOIN run_work_state ws ON ws.run_id = r.run_id",
      "WHERE r.stream_id = ? AND lower(ws.summary || ' ' || ws.facts_json || ' ' ||",
      "ws.evidence_json || ' ' || ws.artifacts_json) LIKE ?",
      "ORDER BY COALESCE(r.completed_at, r.started_at) DESC, r.run_sequence DESC LIMIT ?",
    ].join(" ")).all(streamId, pattern, limit) as unknown as Array<{
      run_id: string;
      completed_at: string | null;
      started_at: string;
      status: string;
      workstream_id: string | null;
      summary: string;
    }>;
    return rows.map((row) => ({
      ref: "run:" + row.run_id,
      kind: "run" as const,
      at: row.completed_at ?? row.started_at,
      preview: preview(row.status + ": " + row.summary),
      ...(row.workstream_id ? { workstreamId: row.workstream_id } : {}),
      resourceIds: this.runResourceIds(row.run_id),
    }));
  }

  private messageResourceIds(messageId: string): string[] {
    const rows = this.database.prepare([
      "SELECT resource_id FROM message_resources WHERE message_id = ? ORDER BY resource_id",
    ].join(" ")).all(messageId) as unknown as Array<{ resource_id: string }>;
    return rows.map((row) => row.resource_id);
  }

  private runResourceIds(runId: string): string[] {
    const rows = this.database.prepare([
      "SELECT resource_id FROM (",
      "SELECT resource_id FROM resource_events WHERE run_id = ?",
      "UNION SELECT mr.resource_id FROM message_resources mr",
      "JOIN messages m ON m.message_id = mr.message_id WHERE m.run_id = ?",
      ") ORDER BY resource_id",
    ].join(" ")).all(runId, runId) as unknown as Array<{ resource_id: string }>;
    return rows.map((row) => row.resource_id);
  }

  private requireStream(streamId: string): void {
    if (!readAgentStream(this.database, streamId)) {
      throw new ContextEngineServiceError({
        code: "AGENT_STREAM_NOT_FOUND",
        message: "Agent stream does not exist.",
        details: { streamId },
      });
    }
  }
}

function boundedMessages(
  source: StreamMessage[],
  maxChars: number,
  requestedToSeq: number,
): ReadAgentHistoryResponse {
  const messages: StreamMessage[] = [];
  let remaining = maxChars;
  for (const message of source.slice(0, MAX_READ_MESSAGES)) {
    if (message.content.length > remaining) {
      if (messages.length === 0) return chunkSingleMessage(message, 0, maxChars);
      break;
    }
    messages.push(message);
    remaining -= message.content.length;
  }
  const last = messages.at(-1);
  const moreByCount = source.length > messages.length;
  const moreByRange = Boolean(last && last.sequence < requestedToSeq);
  const truncated = moreByCount || moreByRange;
  return {
    messages,
    truncated,
    ...(truncated && last ? { continuationFromSeq: last.sequence + 1 } : {}),
  };
}

function chunkSingleMessage(
  message: StreamMessage,
  offsetChars: number,
  maxChars: number,
): ReadAgentHistoryResponse {
  if (offsetChars > message.content.length) throw invalidRef("Message offset exceeds its content.");
  const content = message.content.slice(offsetChars, offsetChars + maxChars);
  const nextOffset = offsetChars + content.length;
  const truncated = nextOffset < message.content.length;
  return {
    messages: [{ ...message, content }],
    truncated,
    ...(truncated
      ? {
          continuationRef: "message:" + message.messageId,
          continuationOffsetChars: nextOffset,
        }
      : {}),
  };
}

function parseEvidenceRef(ref: string): { runId: string; step: number; callId: string } | undefined {
  const match = ref.match(/^run:([^:]+):step:(\d+):call:(.+)$/);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const step = Number(match[2]);
  return Number.isSafeInteger(step) && step > 0
    ? { runId: match[1], step, callId: match[3] }
    : undefined;
}

function exactToolCall(call: RunStepToolCall): RunStepToolCall {
  return structuredClone(call);
}

function deduplicateHits(hits: AgentHistoryHit[]): AgentHistoryHit[] {
  return [...new Map(hits.map((hit) => [hit.ref, hit])).values()];
}

function normalizedTerms(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(0, 12);
}

function preview(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= 400 ? normalized : normalized.slice(0, 399) + "…";
}

function invalidRef(message: string): ContextEngineServiceError {
  return new ContextEngineServiceError({ code: "HISTORY_REF_INVALID", message });
}
