import type { ActOutput, VerifyOutput, VerificationExecutionStatus } from "./types.js";

function formatToolErrors(calls: Array<{ tool: string; error?: string }>): string {
  return calls
    .filter((call) => call.error)
    .map((call) => `${call.tool}: ${call.error}`)
    .join("; ");
}

export function deriveExecutionStatus(actOutput: ActOutput): VerificationExecutionStatus {
  if (actOutput.toolCalls.length === 0) {
    return "no_tools";
  }

  const successfulCalls = actOutput.toolCalls.filter((call) => !call.error).length;
  if (successfulCalls === 0) {
    return "all_failed";
  }
  if (successfulCalls === actOutput.toolCalls.length) {
    return "all_succeeded";
  }
  return "partial_success";
}

/**
 * Execution-only verification gates.
 *
 * These gates answer a narrow question: do we have enough successful execution
 * to justify output validation? They never mark a step as passed on their own.
 */
export function checkVerificationGates(actOutput: ActOutput): VerifyOutput | null {
  const executionStatus = deriveExecutionStatus(actOutput);

  if (executionStatus === "all_failed") {
    return {
      passed: false,
      method: "execution_gate",
      executionStatus,
      validationStatus: "skipped",
      summary: "Step failed during tool execution before output validation could run.",
      evidenceSummary: `All tool calls failed: ${formatToolErrors(actOutput.toolCalls)}`,
      evidenceItems: actOutput.toolCalls
        .filter((call) => call.error)
        .map((call) => `${call.tool}: ${call.error}`),
      newFacts: [],
      artifacts: [],
      usedRawArtifacts: [],
    };
  }

  if (executionStatus === "no_tools" && actOutput.finalText.trim().length === 0) {
    return {
      passed: false,
      method: "execution_gate",
      executionStatus,
      validationStatus: "skipped",
      summary: "Step produced no output to validate.",
      evidenceSummary: actOutput.stoppedEarlyReason
        ? `Execution stopped before producing output: ${actOutput.stoppedEarlyReason}.`
        : "Execution produced no tool output and no final text.",
      evidenceItems: actOutput.stoppedEarlyReason ? [actOutput.stoppedEarlyReason] : [],
      newFacts: [],
      artifacts: [],
      usedRawArtifacts: [],
    };
  }

  return null;
}
