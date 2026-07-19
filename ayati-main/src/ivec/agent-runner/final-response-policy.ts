import { isAbsolute, resolve } from "node:path";
import type { LoopState, StepSummary } from "../types.js";
import type { AgentDecision } from "./decision.js";
import { isObservationalTool } from "../../skills/tool-taxonomy.js";
import { isGitContextReadOnlyToolName } from "../../skills/builtins/git-context/tool-policy.js";
import { isGitContextRoutingToolName } from "./runtime-capability-mode.js";
import { stepUsesFileMutationTool } from "./task-routing-policy.js";

export function canMarkTerminalReplyDone(state: LoopState): boolean {
  return state.workState.status === "not_done"
    && (state.workState.openWork?.length ?? 0) === 0
    && (state.workState.blockers?.length ?? 0) === 0
    && !state.workState.userInputNeeded?.trim()
    && !hasUnresolvedFileMutationFailure(state);
}

export function shouldRejectTerminalReplyForUnresolvedMutation(
  state: LoopState,
  decision: Extract<AgentDecision, { kind: "reply" }>,
): { reason: string; failedStep?: StepSummary } | null {
  if (decision.status !== "completed" || state.runClass !== "task" || !isFileMutationRequest(state.userMessage)) {
    return null;
  }
  const failedStep = latestFileMutationStep(state.completedSteps, "failed");
  if (!failedStep) {
    return null;
  }
  const latestSuccess = latestFileMutationStep(state.completedSteps, "success");
  if (latestSuccess && latestSuccess.step > failedStep.step) {
    return null;
  }
  return {
    reason: "The user asked for file changes, but the latest file mutation failed and no later file mutation succeeded. Continue with patch_files, write_files, or another mutation tool instead of sending a final reply.",
    failedStep,
  };
}

export function isFileMutationRequest(message: string): boolean {
  return /\b(?:create|write|save|edit|update|change|modify|patch|replace|delete|remove|move|rename|fix|build|generate)\b/i.test(message)
    && /\b(?:file|files|folder|directory|path|html|css|js|ts|tsx|jsx|json|md|txt|site|website|app|page|component|code)\b/i.test(message);
}

export function deriveUserInputNeededFromTerminalReply(message: string): string | undefined {
  const sentences = message
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const waitingSentence = sentences.find(isUserInputRequestSentence);
  return waitingSentence ? normalizeTerminalReplyRequest(waitingSentence) : undefined;
}

export function canFinalizeFromWorkState(state: LoopState): boolean {
  return state.workState.status === "done"
    || state.workState.status === "needs_user_input";
}

export function isUsableFinalResponseMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (["task_completion", "decision_load_tools", "ask_user_feedback"].includes(trimmed)) {
    return false;
  }
  if (/\b(?:task_completion|decision_load_tools|ask_user_feedback)\b/i.test(trimmed)) {
    return false;
  }
  if (/<tool_call>|tool use displayed to the user as a native function call/i.test(trimmed)) {
    return false;
  }
  if (!trimmed.startsWith("{")) {
    return true;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return true;
    }
    const value = parsed as Record<string, unknown>;
    return !["act", "load_tools", "task_completion", "ask_user", "reply"].includes(String(value["kind"] ?? ""));
  } catch {
    return true;
  }
}

export function buildBlockedWorkStateReply(state: LoopState): string {
  const blocker = state.workState.blockers?.find((item) => item.trim().length > 0);
  return blocker ? `I couldn't complete the task. ${blocker}` : "I couldn't complete the task.";
}

export function buildVerifiedCompletionReply(state: LoopState, step?: StepSummary): string {
  const verifiedCompletionSummary = state.verifiedCompletionSummary?.trim();
  if (verifiedCompletionSummary && !looksLikeInternalCompletionText(verifiedCompletionSummary)) {
    return verifiedCompletionSummary;
  }

  const artifacts = normalizeList(step && stepHasGeneratedArtifactEvidence(step) ? step.artifacts : [])
    .filter((artifact) => isDurableStepArtifact(artifact))
    .map((artifact) => displayArtifactPath(artifact));
  if (artifacts.length > 0) {
    return `Done. I created or updated ${formatDisplayList(artifacts)}.`;
  }

  const summary = state.workState.summary?.trim();
  if (summary && !looksLikeInternalCompletionText(summary)) {
    return summary;
  }
  return "Done. I completed the task.";
}

export function buildFailureReply(state: LoopState): string {
  const latest = state.failureHistory[state.failureHistory.length - 1];
  if (!latest) {
    return "I couldn't complete the task.";
  }
  return `I couldn't complete the task. Latest failure: ${latest.reason}`;
}

export function isDurableStepArtifact(artifact: string): boolean {
  const normalized = artifact.trim();
  if (!normalized || normalized.startsWith("steps/")) {
    return false;
  }
  return !normalized.includes("/observations/");
}

export function stepHasGeneratedArtifactEvidence(step: StepSummary): boolean {
  const toolsUsed = step.toolsUsed ?? [];
  if (toolsUsed.length === 0) {
    return true;
  }
  return toolsUsed.some((tool) => !isObservationalTool(tool) && !isGitContextReadOnlyToolName(tool) && !isGitContextRoutingToolName(tool));
}

function hasUnresolvedFileMutationFailure(state: LoopState): boolean {
  return Boolean(shouldRejectTerminalReplyForUnresolvedMutation(state, {
    kind: "reply",
    status: "completed",
    message: "",
  }));
}

export function latestFileMutationStep(steps: StepSummary[], outcome: "success" | "failed"): StepSummary | undefined {
  return [...steps]
    .reverse()
    .find((step) => step.outcome === outcome && stepUsesFileMutationTool(step));
}

function isUserInputRequestSentence(sentence: string): boolean {
  return /\b(?:send|tell|provide|share|choose|confirm|pick|select|let me know|when you|once you|after you)\b/i.test(sentence)
    && /\b(?:you|your|me|the|which|what|when|whether)\b/i.test(sentence);
}

function normalizeTerminalReplyRequest(sentence: string): string {
  const trimmed = sentence.trim();
  if (trimmed.endsWith(".") || trimmed.endsWith("?") || trimmed.endsWith("!")) {
    return trimmed;
  }
  return `${trimmed}.`;
}

function displayArtifactPath(path: string): string {
  const trimmed = path.trim();
  if (!isAbsolute(trimmed)) {
    return trimmed;
  }
  const workspaceDir = process.env["AYATI_WORKSPACE_DIR"];
  if (!workspaceDir) {
    return trimmed;
  }
  const workspaceRoot = resolve(workspaceDir);
  const relative = trimmed.startsWith(`${workspaceRoot}/`)
    ? trimmed.slice(workspaceRoot.length + 1)
    : trimmed;
  return relative || trimmed;
}

function formatDisplayList(values: string[]): string {
  const display = values.slice(0, 4).map((value) => `\`${value}\``);
  const remaining = Math.max(0, values.length - display.length);
  if (remaining > 0) {
    display.push(`${remaining} more`);
  }
  if (display.length === 1) {
    return display[0]!;
  }
  if (display.length === 2) {
    return `${display[0]} and ${display[1]}`;
  }
  return `${display.slice(0, -1).join(", ")}, and ${display[display.length - 1]}`;
}

function looksLikeInternalCompletionText(text: string): boolean {
  return /\b(?:tool(?:\s+call)?|sha256|deterministic verification|evidence contract|assertion|reducer|work state|harness|completion candidate|batch write)\b/i.test(text);
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}
