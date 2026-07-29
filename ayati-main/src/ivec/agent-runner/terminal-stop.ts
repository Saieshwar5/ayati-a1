import type { LoopState, WorkState } from "../types.js";
import { getActiveFailures } from "./failure-lifecycle.js";
import { isUsableFinalResponseMessage } from "./final-response-policy.js";
import {
  createVirtualModeRepair,
  isVirtualGraphActive,
  type TerminalStopRequest,
  type VirtualModeRepair,
} from "./virtual-mode.js";
import { workStateBlockers } from "./work-state/selectors.js";

export type TerminalStopResult =
  | {
      accepted: true;
      outcome: TerminalStopRequest["outcome"];
      response: string;
      nextWorkState: WorkState;
    }
  | {
      accepted: false;
      repair: VirtualModeRepair;
    };

export function dispatchTerminalStop(
  state: LoopState,
  request: TerminalStopRequest,
): TerminalStopResult {
  const response = request.response.trim();
  if (!isVirtualGraphActive(state.virtualMode)) {
    return rejected("A terminal stop is available only after the virtual graph is active.");
  }
  if (!response || !isUsableFinalResponseMessage(response)) {
    return rejected("Provide one complete user-facing response without internal control language.");
  }

  switch (request.outcome) {
    case "needs_user_input":
      if (!hasMaterialUncertainty(state)) {
        return rejected("No current ambiguity or missing user decision supports a needs-user-input outcome.");
      }
      return {
        accepted: true,
        outcome: request.outcome,
        response,
        nextWorkState: {
          ...state.workState,
          status: "needs_user_input",
          importantContext: appendImportantContext(
            state.workState,
            "decision",
            "Awaiting user response: " + response,
          ),
          nextAction: "Resume the same responsibility after the user answers.",
        },
      };
    case "blocked": {
      const blockers = currentBlockers(state);
      if (blockers.length === 0) {
        return rejected("No current blocker supports a blocked outcome.");
      }
      return {
        accepted: true,
        outcome: request.outcome,
        response,
        nextWorkState: {
          ...state.workState,
          status: "blocked",
          importantContext: blockers.reduce(
            (items, blocker) => appendImportantContext(
              { ...state.workState, importantContext: items },
              "constraint",
              blocker,
            ),
            state.workState.importantContext,
          ),
          nextAction: "Resume when the blocker changes or the user provides the required access.",
        },
      };
    }
    case "failed":
      if (!hasCurrentFailure(state)) {
        return rejected("No current unrecovered failure supports a failed outcome.");
      }
      return {
        accepted: true,
        outcome: request.outcome,
        response,
        nextWorkState: {
          ...state.workState,
          status: "in_progress",
          nextAction: "Retry from the latest verified state when a safe recovery is available.",
        },
      };
  }
}

function rejected(message: string): TerminalStopResult {
  return {
    accepted: false,
    repair: createVirtualModeRepair(
      "VALIDATION_REJECTED",
      message,
      [],
      ["Continue working in the current graph, or retry decision_stop with a truthful supported outcome."],
    ),
  };
}

function hasMaterialUncertainty(state: LoopState): boolean {
  if (
    state.workState.status === "needs_user_input"
  ) {
    return true;
  }
  if (getActiveFailures(state.failureHistory).some((failure) => {
    const failureText = [
      failure.reason,
      failure.repair?.message,
      ...(failure.repair?.allowedNextActions ?? []),
    ].filter(Boolean).join(" ");
    return failure.failureType === "missing_path"
      || /\bMODE_(?:RESOLUTION_AMBIGUOUS|TARGET_REQUIRED)\b/.test(failureText);
  })) {
    return true;
  }
  if (
    /\b(?:it|this|that|these|those|them|the file|the folder|the directory)\b/i.test(state.userMessage)
    && !/(?:^|\s)\/[^\s]+/.test(state.userMessage)
    && (
      state.virtualMode.active === "observe.locate"
      || state.virtualMode.active === "workstream.route"
    )
  ) {
    return true;
  }
  return (state.toolContext?.toolCalls ?? []).some((call) => {
    if (call.status !== "success") return false;
    if (/\b(?:no matches?|multiple matches|more than one|not found|none found)\b/i.test(call.output)) {
      return true;
    }
    const metadata = asRecord(call.projectionMetadata);
    return ["matches", "candidates", "workstreams", "resources"].some((key) => {
      const values = metadata?.[key];
      return Array.isArray(values) && values.length !== 1;
    });
  });
}

function currentBlockers(state: LoopState): string[] {
  const blockers = [
    ...workStateBlockers(state.workState),
    ...getActiveFailures(state.failureHistory).map((failure) => failure.reason),
  ].map((value) => value.trim()).filter(Boolean);
  return [...new Set(blockers)].slice(0, 4);
}

function appendImportantContext(
  workState: WorkState,
  kind: WorkState["importantContext"][number]["kind"],
  value: string,
): WorkState["importantContext"] {
  const normalized = value.trim();
  if (!normalized) return workState.importantContext;
  if (workState.importantContext.some((item) =>
    item.kind === kind && item.value.trim() === normalized)) {
    return workState.importantContext;
  }
  return [...workState.importantContext, { kind, value: normalized }].slice(-12);
}

function hasCurrentFailure(state: LoopState): boolean {
  return getActiveFailures(state.failureHistory).length > 0
    || state.completedSteps.some((step) => step.outcome === "failed");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
