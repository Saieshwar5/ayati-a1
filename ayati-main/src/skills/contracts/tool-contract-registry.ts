import type { ToolDefinition, ToolResult, ToolResultV2 } from "../types.js";
import { normalizeToolResultV2 } from "./tool-result-normalizer.js";
import { verifyToolContract } from "./assertions.js";

function withV2(result: ToolResult, v2: ToolResultV2): ToolResult {
  return {
    ...result,
    v2,
  };
}

export async function applyToolContract(
  tool: ToolDefinition,
  input: unknown,
  result: ToolResult,
): Promise<ToolResult> {
  if (!result.v2 && !tool.resultContract && !tool.outputSchema) {
    return result;
  }

  const v2 = normalizeToolResultV2(result);
  const verification = await verifyToolContract(tool, input, v2);
  if (!verification) {
    return withV2(result, v2);
  }

  const verifiedV2: ToolResultV2 = {
    ...v2,
    artifacts: verification.artifacts.length > 0 ? verification.artifacts : v2.artifacts,
    verification,
  };

  if (verification.status === "failed") {
    return {
      ...result,
      ok: false,
      error: verification.summary,
      v2: {
        ...verifiedV2,
        operationStatus: "failed",
        code: "CONTRACT_ASSERTION_FAILED",
        message: verification.summary,
        error: {
          category: "semantic",
          code: "CONTRACT_ASSERTION_FAILED",
          message: verification.summary,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Inspect failed assertion results and retry with corrected tool behavior or input."],
        },
      },
    };
  }

  return withV2(result, verifiedV2);
}
