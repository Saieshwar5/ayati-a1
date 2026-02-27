import type { ActOutput, VerifyOutput } from "./types.js";

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function isNoProgressOutput(output: string): boolean {
  const text = normalizeText(output);
  if (text.length === 0) return true;

  return (
    text === "(no matches)" ||
    text === "(empty directory)" ||
    text.includes("no matches") ||
    text.includes("not found") ||
    text.includes("no such file") ||
    text.includes("does not exist")
  );
}

function expectsDiscoveryOutcome(successCriteria: string): boolean {
  return /(find|locate|search|discover|path|file|directory|folder|where)/i.test(successCriteria);
}

function allowsAbsenceOutcome(successCriteria: string): boolean {
  return /(confirm|verify|ensure).*(absence|missing|not found|does not exist|no matches)/i.test(successCriteria);
}

/**
 * Machine-checkable verification gates. Pure deterministic functions — no LLM calls.
 *
 * Gates checked in order:
 * 1. No-tools gate: Zero tool calls + non-empty finalText → passed: true
 * 2. Mixed-result gate: evaluate successful outputs and failed tool errors together
 * 3. Discovery no-progress gate: discovery intent with no matches and absence not allowed → passed: false
 * 4. All-success-with-output gate: successful calls with output → passed: true
 *
 * Returns null if no gate matched (triggers LLM fallback in executor).
 */
export function checkVerificationGates(
  actOutput: ActOutput,
  successCriteria: string,
): VerifyOutput | null {
  const { toolCalls, finalText } = actOutput;

  // Gate 1: No-tools gate
  if (toolCalls.length === 0 && finalText.trim().length > 0) {
    return {
      passed: true,
      method: "gate",
      evidence: `No tools called, assistant produced text response.`,
      newFacts: [],
      artifacts: [],
    };
  }

  // Gate 2+: Tool-call outcomes
  if (toolCalls.length > 0) {
    const successfulCalls = toolCalls.filter((call) => !call.error);
    const failedCalls = toolCalls.filter((call) => !!call.error);
    const outputs = successfulCalls.map((call) => call.output ?? "");
    const hasOutput = outputs.some((output) => output.trim().length > 0);
    const usefulOutput = outputs.some((output) => output.trim().length > 0 && !isNoProgressOutput(output));
    const hasCriticalBlocker = failedCalls.some((call) => isCriticalToolError(call.error ?? ""));

    if (successfulCalls.length === 0 && failedCalls.length > 0) {
      return {
        passed: false,
        method: "gate",
        evidence: `All tool calls failed: ${formatToolErrors(failedCalls)}`,
        newFacts: [],
        artifacts: [],
      };
    }

    if (
      successfulCalls.length > 0 &&
      expectsDiscoveryOutcome(successCriteria) &&
      !allowsAbsenceOutcome(successCriteria) &&
      outputs.every((output) => isNoProgressOutput(output))
    ) {
      return {
        passed: false,
        method: "gate",
        evidence: "Tools executed but returned no matches / no progress for the requested discovery outcome.",
        newFacts: [],
        artifacts: [],
      };
    }

    if (usefulOutput && hasCriticalBlocker) {
      return {
        passed: false,
        method: "gate",
        evidence: `Useful output found but blocked by critical failure: ${formatToolErrors(failedCalls)}`,
        newFacts: [],
        artifacts: [],
      };
    }

    if (usefulOutput && !hasCriticalBlocker) {
      const warningSuffix = failedCalls.length > 0
        ? ` Some calls failed: ${formatToolErrors(failedCalls)}`
        : "";
      return {
        passed: true,
        method: "gate",
        evidence: `At least one tool produced useful output.${warningSuffix}`,
        newFacts: [],
        artifacts: [],
      };
    }

    if (hasCriticalBlocker && failedCalls.length > 0 && !usefulOutput) {
      return {
        passed: false,
        method: "gate",
        evidence: `Critical tool failure: ${formatToolErrors(failedCalls)}`,
        newFacts: [],
        artifacts: [],
      };
    }

    if (failedCalls.length > 0 && !usefulOutput) {
      return {
        passed: false,
        method: "gate",
        evidence: `Tool call failures prevented useful progress: ${formatToolErrors(failedCalls)}`,
        newFacts: [],
        artifacts: [],
      };
    }

    if (successfulCalls.length > 0 && hasOutput) {
      return {
        passed: true,
        method: "gate",
        evidence: "All tools completed successfully with output.",
        newFacts: [],
        artifacts: [],
      };
    }
  }

  // No gate matched — LLM fallback needed
  return null;
}

function formatToolErrors(calls: Array<{ tool: string; error?: string }>): string {
  return calls
    .filter((call) => call.error)
    .map((call) => `${call.tool}: ${call.error}`)
    .join("; ");
}

function isCriticalToolError(error: string): boolean {
  const normalized = normalizeText(error);
  return (
    normalized.includes("permission denied") ||
    normalized.includes("eacces") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("validation error")
  );
}
