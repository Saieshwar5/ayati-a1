import type { LlmMessage, LlmTurnInput } from "../core/contracts/llm-protocol.js";

const BYTES_PER_TOKEN = 4;
const REQUEST_OVERHEAD_TOKENS = 3;
const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_OVERHEAD_TOKENS = 8;

function estimateSerializedTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

function estimateMessageTokens(message: LlmMessage): number {
  switch (message.role) {
    case "system":
    case "user":
    case "assistant":
      return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content);
    case "assistant_tool_calls":
      return (
        MESSAGE_OVERHEAD_TOKENS +
        estimateTextTokens(message.content ?? "") +
        message.calls.reduce((sum, call) => {
          return (
            sum +
            TOOL_OVERHEAD_TOKENS +
            estimateTextTokens(call.id) +
            estimateTextTokens(call.name) +
            estimateSerializedTokens(call.input ?? {})
          );
        }, 0)
      );
    case "tool":
      return (
        MESSAGE_OVERHEAD_TOKENS +
        TOOL_OVERHEAD_TOKENS +
        estimateTextTokens(message.toolCallId) +
        estimateTextTokens(message.name) +
        estimateTextTokens(message.content)
      );
    default:
      return MESSAGE_OVERHEAD_TOKENS;
  }
}

export interface LocalInputTokenEstimate {
  messageTokens: number;
  toolSchemaTokens: number;
  totalTokens: number;
}

export function estimateTextTokens(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN));
}

export function estimateTurnInputTokens(input: LlmTurnInput): LocalInputTokenEstimate {
  const messageTokens = input.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

  const toolSchemaTokens = (input.tools ?? []).reduce((sum, tool) => {
    return (
      sum +
      TOOL_OVERHEAD_TOKENS +
      estimateTextTokens(tool.name) +
      estimateTextTokens(tool.description) +
      estimateSerializedTokens(tool.inputSchema)
    );
  }, 0);

  return {
    messageTokens,
    toolSchemaTokens,
    totalTokens: REQUEST_OVERHEAD_TOKENS + messageTokens + toolSchemaTokens,
  };
}
