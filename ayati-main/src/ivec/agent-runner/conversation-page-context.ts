import type { RunToolCallContext } from "../types.js";

const CONVERSATION_READ_TOOL = "agent_conversation_read";

/**
 * Conversation pages are a model-facing viewport over exact stored messages.
 * Keep the newest successful page in full and replace older page payloads with
 * bounded navigation metadata. Exact step evidence and the message archive are
 * not changed.
 */
export function compactSupersededConversationPages(
  calls: RunToolCallContext[],
): RunToolCallContext[] {
  let latestIndex = -1;
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]!;
    if (call.tool === CONVERSATION_READ_TOOL && call.status === "success") {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return calls;
  return calls.map((call, index) => {
    if (index >= latestIndex
      || call.tool !== CONVERSATION_READ_TOOL
      || call.status !== "success") {
      return call;
    }
    const page = readRecord(call.projectionMetadata?.["page"]);
    const compactOutput = JSON.stringify({
      status: "superseded",
      message: "An older conversation page was replaced by the next page in active prompt context.",
      ...(page ? { page } : {}),
      exactMessagesRemainAvailable: true,
    });
    return {
      ...call,
      retention: "evidence_only",
      output: compactOutput,
      rawOutputChars: call.rawOutputChars ?? call.output.length,
      outputTruncated: true,
    };
  });
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
