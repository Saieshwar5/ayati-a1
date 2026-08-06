import type { AgentHistoryKind, ContextEngineService } from "ayati-context-engine";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";

export function createAgentHistoryTools(service: ContextEngineService): ToolDefinition[] {
  return [
    searchAgentHistoryTool(service),
    readAgentConversationTool(service),
    readAgentHistoryTool(service),
  ];
}

function searchAgentHistoryTool(service: ContextEngineService): ToolDefinition {
  return {
    name: "agent_history_search",
    description: "Search older messages, run summaries, and exact evidence in the current agent stream. Returns stable references for agent_history_read.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        kinds: {
          type: "array",
          uniqueItems: true,
          maxItems: 3,
          items: { enum: ["message", "run", "evidence"] },
        },
        limit: { type: "integer", minimum: 1, maximum: 25 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        hits: { type: "array", items: { type: "object" } },
        count: { type: "integer" },
      },
      required: ["hits", "count"],
      additionalProperties: false,
    },
    annotations: readAnnotations(),
    resultContract: succeededContract(),
    async execute(input, context): Promise<ToolResult> {
      const record = objectInput(input);
      const streamId = currentStreamId(context);
      const query = stringField(record, "query");
      const kinds = historyKinds(record["kinds"]);
      const limit = optionalInteger(record["limit"]);
      if (!streamId || !query || kinds === null
        || (record["limit"] !== undefined && (limit === undefined || limit < 1 || limit > 25))) {
        return historyError("History search requires the current agent stream, a query, valid kinds, and a limit from 1 to 25.");
      }
      try {
        const result = await service.searchAgentHistory({
          streamId,
          query,
          ...(kinds ? { kinds } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return okJsonResult({
          code: "AGENT_HISTORY_FOUND",
          message: `Found ${result.hits.length} agent-history result(s).`,
          structuredContent: { hits: result.hits, count: result.hits.length },
        });
      } catch (error) {
        return historyError(errorMessage(error));
      }
    },
  };
}

function readAgentConversationTool(service: ContextEngineService): ToolDefinition {
  return {
    name: "agent_conversation_read",
    description: [
      "Page backward through exact user and assistant messages, including readable legacy system-event records; each returned page is chronological.",
      "Omit cursor and beforeSeq for the latest page; use olderCursor for the next older page.",
      "If contentTruncated is true, continue that message with agent_history_read using continuationRef and continuationOffsetChars.",
      "Use agent_history_search instead when a known topic or phrase can locate the needed history directly.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          minLength: 1,
          description: "Exact olderCursor returned by the preceding agent_conversation_read page.",
        },
        beforeSeq: {
          type: "integer",
          minimum: 1,
          description: "On the first page only, return messages strictly before this exact sequence.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum stored messages/events. Defaults to 50.",
        },
        maxChars: { type: "integer", minimum: 1, maximum: 32000 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        messages: { type: "array", items: { type: "object" } },
        page: { type: "object" },
        contentTruncated: { type: "boolean" },
        continuationRef: { type: "string" },
        continuationOffsetChars: { type: "integer" },
        hasMore: { type: "boolean" },
      },
      required: ["messages", "page", "contentTruncated", "hasMore"],
      additionalProperties: false,
    },
    annotations: readAnnotations(),
    observationPolicy: {
      outputImportance: "decision_context",
      rawStorage: "always",
      maxObservationChars: 32_000,
    },
    resultContract: succeededContract(),
    async execute(input, context): Promise<ToolResult> {
      const record = objectInput(input);
      const streamId = currentStreamId(context);
      const cursor = stringField(record, "cursor");
      const beforeSeq = optionalInteger(record["beforeSeq"]);
      const limit = optionalInteger(record["limit"]);
      const maxChars = optionalInteger(record["maxChars"]);
      const cursorProvided = record["cursor"] !== undefined;
      const beforeProvided = record["beforeSeq"] !== undefined;
      if (!streamId
        || (cursorProvided && !cursor)
        || (beforeProvided && (beforeSeq === undefined || beforeSeq < 1))
        || (cursorProvided && beforeProvided)
        || (record["limit"] !== undefined && (limit === undefined || limit < 1 || limit > 50))
        || (record["maxChars"] !== undefined
          && (maxChars === undefined || maxChars < 1 || maxChars > 32_000))) {
        return conversationError(
          "Conversation read requires the current stream, either cursor or beforeSeq (not both), a limit from 1 to 50, and maxChars from 1 to 32000.",
        );
      }
      try {
        const result = await service.readAgentConversation({
          streamId,
          ...(cursor ? { cursor } : {}),
          ...(beforeSeq !== undefined ? { beforeSeq } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(maxChars !== undefined ? { maxChars } : {}),
        });
        const hasMore = result.page.hasOlder || result.contentTruncated;
        const structuredContent = {
          page: result.page,
          contentTruncated: result.contentTruncated,
          ...(result.continuationRef ? { continuationRef: result.continuationRef } : {}),
          ...(result.continuationOffsetChars !== undefined
            ? { continuationOffsetChars: result.continuationOffsetChars }
            : {}),
          hasMore,
          messages: result.messages,
        };
        return okJsonResult({
          code: "AGENT_CONVERSATION_READ",
          message: result.page.count === 0
            ? "No conversation messages are available in this range."
            : result.contentTruncated
              ? `Read part of one exact conversation message; continue it from offset ${result.continuationOffsetChars ?? 0} with agent_history_read.`
              : hasMore
              ? `Read ${result.page.count} exact conversation message(s); more exact history is available.`
              : `Read ${result.page.count} exact conversation message(s).`,
          structuredContent,
        });
      } catch (error) {
        return conversationError(errorMessage(error));
      }
    },
  };
}

function readAgentHistoryTool(service: ContextEngineService): ToolDefinition {
  return {
    name: "agent_history_read",
    description: "Read exact agent-stream messages or run evidence from a stable history reference or inclusive message-sequence range.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1 },
        fromSeq: { type: "integer", minimum: 1 },
        toSeq: { type: "integer", minimum: 1 },
        maxChars: { type: "integer", minimum: 1, maximum: 32000 },
        offsetChars: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        messages: { type: "array", items: { type: "object" } },
        evidence: { type: "object" },
        truncated: { type: "boolean" },
        continuationFromSeq: { type: "integer" },
        continuationRef: { type: "string" },
        continuationOffsetChars: { type: "integer" },
      },
      required: ["messages", "truncated"],
      additionalProperties: false,
    },
    annotations: readAnnotations(),
    resultContract: succeededContract(),
    async execute(input, context): Promise<ToolResult> {
      const record = objectInput(input);
      const streamId = currentStreamId(context);
      const ref = stringField(record, "ref");
      const fromSeq = optionalInteger(record["fromSeq"]);
      const toSeq = optionalInteger(record["toSeq"]);
      const maxChars = optionalInteger(record["maxChars"]);
      const offsetChars = optionalInteger(record["offsetChars"]);
      const refMode = Boolean(ref)
        && fromSeq === undefined
        && toSeq === undefined
        && (offsetChars === undefined || offsetChars >= 0);
      const rangeMode = !ref
        && fromSeq !== undefined
        && toSeq !== undefined
        && fromSeq >= 1
        && toSeq >= fromSeq
        && offsetChars === undefined;
      if (!streamId || (!refMode && !rangeMode)
        || (maxChars !== undefined && (maxChars < 1 || maxChars > 32_000))) {
        return historyError("History read requires either one exact ref or an inclusive fromSeq/toSeq range; maxChars must be from 1 to 32000.");
      }
      try {
        const result = refMode
          ? await service.readAgentHistory({
              streamId,
              ref: ref!,
              ...(maxChars !== undefined ? { maxChars } : {}),
              ...(offsetChars !== undefined ? { offsetChars } : {}),
            })
          : await service.readAgentHistory({
              streamId,
              fromSeq: fromSeq!,
              toSeq: toSeq!,
              ...(maxChars !== undefined ? { maxChars } : {}),
            });
        return okJsonResult({
          code: "AGENT_HISTORY_READ",
          message: result.truncated
            ? "Read a bounded exact history chunk; continue with the returned cursor."
            : "Read exact agent history.",
          structuredContent: result,
        });
      } catch (error) {
        return historyError(errorMessage(error));
      }
    },
  };
}

function currentStreamId(context?: ToolExecutionContext): string | undefined {
  const streamId = context?.sessionId?.trim();
  return streamId || undefined;
}

function historyKinds(value: unknown): AgentHistoryKind[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) return null;
  const result = value.filter((kind): kind is AgentHistoryKind =>
    kind === "message" || kind === "run" || kind === "evidence"
  );
  return result.length === value.length && new Set(result).size === result.length
    ? result
    : null;
}

function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function readAnnotations() {
  return commonAnnotations({
    domain: "git_context",
    readOnly: true,
    idempotent: true,
    retrySafe: true,
  });
}

function historyError(message: string): ToolResult {
  return errorResult({
    code: "AGENT_HISTORY_READ_FAILED",
    message,
    category: "validation",
    retryable: false,
    suggestedNextActions: ["Search history again or use an exact returned reference/continuation cursor."],
  });
}

function conversationError(message: string): ToolResult {
  return errorResult({
    code: "AGENT_CONVERSATION_READ_FAILED",
    message,
    category: "validation",
    retryable: false,
    suggestedNextActions: [
      "Use the exact olderCursor returned by the previous page, or omit it to read the latest page.",
    ],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
