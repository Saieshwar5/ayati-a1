import type { LoopState, StepSummary } from "../types.js";
import type { AgentDecision } from "./decision.js";
import {
  isObservationalTool,
  NATIVE_CONTROL_TOOL_NAMES,
} from "../../skills/tool-taxonomy.js";
import { isGitContextReadOnlyToolName } from "../../skills/builtins/git-context/tool-policy.js";
import { isGitContextRoutingToolName } from "./workstream-binding-capability-policy.js";
import { latestActiveFailure } from "./failure-lifecycle.js";
import {
  workStateBlockers,
  workStateOpenTasks,
} from "./work-state/selectors.js";

const FILE_MUTATION_TOOL_NAMES = new Set([
  "patch_files",
  "write_files",
  "copy",
  "set_permissions",
  "delete",
  "move",
  "create_directory",
]);

export function canMarkTerminalReplyDone(state: LoopState): boolean {
  return state.workState.status === "in_progress"
    && workStateOpenTasks(state.workState).length === 0
    && workStateBlockers(state.workState).length === 0
    && !latestActiveFailure(state.failureHistory)
    && !hasUnresolvedFileMutationFailure(state);
}

export function shouldRejectTerminalReplyForUnresolvedMutation(
  state: LoopState,
  decision: Extract<AgentDecision, { kind: "reply" }>,
): { reason: string; failedStep?: StepSummary } | null {
  if (decision.status !== "completed" || !isWorkstreamBound(state) || !isFileMutationRequest(state.userMessage)) {
    return null;
  }
  const failedStep = latestFileMutationStep(state.completedSteps, "failed");
  if (!failedStep) {
    return null;
  }
  if (failedStepIsAccountedForByReportedDenial(state, failedStep)) {
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

function failedStepIsAccountedForByReportedDenial(
  state: LoopState,
  step: StepSummary,
): boolean {
  const failedCallIds = step.failedCallIds ?? [];
  if (step.failureType !== "permission" || failedCallIds.length === 0) {
    return false;
  }
  const validation = state.virtualMode.validation;
  if (
    state.virtualMode.active !== "validation"
    || validation?.status !== "passed"
  ) {
    return false;
  }
  const deniedCallIds = new Set(
    validation.checks
      .filter((check) => (
        check.status === "passed"
        && check.kind === "tool.call_denied"
        && Boolean(check.satisfiedBy?.callId)
      ))
      .map((check) => check.satisfiedBy!.callId!),
  );
  return failedCallIds.every((callId) => deniedCallIds.has(callId));
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}

export function isFileMutationRequest(message: string): boolean {
  return /\b(?:create|write|save|edit|update|change|modify|patch|replace|delete|remove|move|rename|fix|build|generate)\b/i.test(message)
    && /\b(?:file|files|folder|directory|path|html|css|js|ts|tsx|jsx|json|md|txt|site|website|app|page|component|code)\b/i.test(message);
}

export function isUsableFinalResponseMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if ([
    "workstream_completion",
    "decision_load_tools",
    "ask_user_feedback",
  ].includes(trimmed) || NATIVE_CONTROL_TOOL_NAMES.includes(
    trimmed as typeof NATIVE_CONTROL_TOOL_NAMES[number],
  )) {
    return false;
  }
  if (
    NATIVE_CONTROL_TOOL_NAMES.some((name) => trimmed.includes(name))
    || /\b(?:workstream_completion|decision_load_tools|ask_user_feedback)\b/i.test(trimmed)
  ) {
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
    return ![
      "act",
      "transition_mode",
      "stop",
      "load_tools",
      "workstream_completion",
      "ask_user",
      "reply",
    ].includes(String(value["kind"] ?? ""));
  } catch {
    return true;
  }
}

export function buildFailureReply(state: LoopState): string {
  const latest = latestActiveFailure(state.failureHistory);
  const subject = isWorkstreamBound(state)
    ? "the current workstream request"
    : "this request";
  if (!latest) {
    return `I couldn't complete ${subject}.`;
  }
  const reason = latest.failureType === "permission"
    ? "The required access was unavailable."
    : latest.failureType === "missing_path"
      ? "A required path was unavailable."
      : latest.failureType === "tool_error"
        ? "A required action did not complete successfully."
        : latest.failureType === "no_progress"
          ? "I could not make further verified progress."
          : latest.failureType === "verify_failed"
            ? "The result could not be verified."
            : "The request could not be completed safely.";
  return `I couldn't complete ${subject}. ${reason}`;
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
    .find((step) => step.outcome === outcome
      && (step.toolsUsed ?? []).some((tool) => FILE_MUTATION_TOOL_NAMES.has(tool)));
}
