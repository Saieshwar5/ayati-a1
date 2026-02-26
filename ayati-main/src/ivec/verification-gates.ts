import type { ActOutput, VerifyOutput } from "./types.js";

/**
 * Machine-checkable verification gates. Pure deterministic functions — no LLM calls.
 *
 * Gates checked in order:
 * 1. Tool error gate: Any tool call has `.error` → passed: false
 * 2. No-tools gate: Zero tool calls + non-empty finalText → passed: true
 *
 * When all tool calls succeed, returns null so the LLM verify runs and extracts
 * newFacts. This is critical — without facts the controller can't tell when a
 * task is already answered.
 *
 * Returns null if no gate matched (triggers LLM fallback in executor).
 */
export function checkVerificationGates(
  actOutput: ActOutput,
  successCriteria: string,
): VerifyOutput | null {
  const { toolCalls, finalText } = actOutput;

  // Gate 1: Tool error gate
  const hasError = toolCalls.some((call) => call.error !== undefined && call.error !== "");
  if (hasError) {
    const errorMessages = toolCalls
      .filter((call) => call.error)
      .map((call) => `${call.tool}: ${call.error}`)
      .join("; ");
    return {
      passed: false,
      method: "gate",
      evidence: `Tool error(s): ${errorMessages}`,
      newFacts: [],
      artifacts: [],
    };
  }

  // Gate 2: No-tools gate
  if (toolCalls.length === 0 && finalText.trim().length > 0) {
    return {
      passed: true,
      method: "gate",
      evidence: `No tools called, assistant produced text response.`,
      newFacts: [],
      artifacts: [],
    };
  }

  // No gate matched — LLM fallback needed (includes successful tool calls)
  return null;
}
