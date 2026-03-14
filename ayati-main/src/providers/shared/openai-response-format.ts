import type { LlmResponseFormat } from "../../core/contracts/llm-protocol.js";

export function toOpenAiResponseFormat(
  responseFormat: LlmResponseFormat | undefined,
): Record<string, unknown> | undefined {
  if (!responseFormat) return undefined;

  if (responseFormat.type === "json_object") {
    return { type: "json_object" };
  }

  return {
    type: "json_schema",
    json_schema: {
      name: responseFormat.name,
      schema: responseFormat.schema,
      ...(responseFormat.strict !== undefined ? { strict: responseFormat.strict } : {}),
    },
  };
}
