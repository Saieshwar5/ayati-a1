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
      return acceptedNeedsUserInput(state, response);
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

export function dispatchDeterministicBindingClarification(
  state: LoopState,
  question: string,
): TerminalStopResult {
  const response = question.trim();
  if (!isVirtualGraphActive(state.virtualMode)) {
    return rejected("A binding clarification is available only after the virtual graph is active.");
  }
  if (!response || !isUsableFinalResponseMessage(response)) {
    return rejected("The deterministic binding gate did not provide a usable clarification.");
  }
  return acceptedNeedsUserInput(state, response);
}

function acceptedNeedsUserInput(
  state: LoopState,
  response: string,
): Extract<TerminalStopResult, { accepted: true }> {
  return {
    accepted: true,
    outcome: "needs_user_input",
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
