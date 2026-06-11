import type { ToolResult, ToolResultV2 } from "../types.js";
import { classifyErrorMessage } from "./errors.js";

function parseStructuredOutput(output: string | undefined): unknown {
  if (!output || output.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

export function normalizeToolResultV2(result: ToolResult): ToolResultV2 {
  if (result.v2) {
    return result.v2;
  }

  if (result.ok) {
    return {
      transportOk: true,
      operationStatus: "succeeded",
      code: "OK",
      message: result.output ?? "Tool operation succeeded.",
      structuredContent: parseStructuredOutput(result.output),
      diagnostics: result.meta,
    };
  }

  const message = result.error ?? "Tool operation failed.";
  const classified = classifyErrorMessage(message);
  return {
    transportOk: true,
    operationStatus: "failed",
    code: classified.code,
    message,
    structuredContent: parseStructuredOutput(result.output),
    error: {
      ...classified,
      message,
    },
    diagnostics: result.meta,
  };
}

