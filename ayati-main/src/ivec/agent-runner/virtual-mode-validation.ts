import { isObservationalTool } from "../../skills/tool-taxonomy.js";
import type { LoopState, WorkState } from "../types.js";
import { evaluateWorkstreamCompletion } from "./workstream-completion-policy.js";
import {
  createVirtualModeRepair,
  isVirtualGraphActive,
  type ValidationRequest,
  type VirtualModeRepair,
} from "./virtual-mode.js";
import { isWorkstreamRoutingObservationTool } from "./workstream-routing-evidence.js";

export type VirtualValidationResult =
  | {
      accepted: true;
      outcome: ValidationRequest["outcome"];
      response: string;
      nextWorkState: WorkState;
      completionSummary?: string;
      completionResources?: Array<{
        resourceId: string;
        path: string;
        resolvedPath: string;
        kind: "file" | "directory";
        description: string;
        aliases: string[];
      }>;
    }
  | {
      accepted: false;
      repair: VirtualModeRepair;
    };

export async function dispatchVirtualValidation(
  state: LoopState,
  rawRequest: ValidationRequest,
): Promise<VirtualValidationResult> {
  const request = normalizeValidationRequest(rawRequest);
  if (!isVirtualGraphActive(state.virtualMode)) {
    return rejectedValidation("decision_validate is unavailable before the virtual graph is active.");
  }
  if (!request.summary || !request.response) {
    return rejectedValidation("Validation requires a non-empty summary and complete user-facing response.");
  }

  if (request.outcome === "completed") {
    if (state.virtualMode.active === "execute") {
      const completion = await evaluateWorkstreamCompletion(state, {
        summary: request.summary,
        resources: request.resources ?? [],
      });
      if (!completion.accepted) {
        return {
          accepted: false,
          repair: createVirtualModeRepair(
            "VALIDATION_REJECTED",
            completion.failures.map((failure) => failure.message).join(" "),
            completion.failures.flatMap((failure) => failure.path ? [failure.path] : []),
            ["Repair the failed deterministic condition, then validate again from the current execute mode."],
          ),
        };
      }
      return {
        accepted: true,
        outcome: request.outcome,
        response: request.response,
        nextWorkState: completion.nextWorkState,
        completionSummary: request.summary,
        completionResources: completion.resources,
      };
    }
    if (!hasSuccessfulObservationEvidence(state)) {
      return rejectedValidation("No successful verified observation from this run supports a completed answer.");
    }
    return {
      accepted: true,
      outcome: request.outcome,
      response: request.response,
      nextWorkState: {
        ...state.workState,
        status: "done",
        summary: request.summary,
        openWork: [],
        blockers: [],
        nextStep: undefined,
        userInputNeeded: undefined,
      },
    };
  }

  if (request.outcome === "needs_user_input") {
    if (!canValidateNeedsUserInput(state)) {
      return rejectedValidation("No observed ambiguity, deterministic gate result, or failed target lookup supports a needs-input outcome.");
    }
    return {
      accepted: true,
      outcome: request.outcome,
      response: request.response,
      nextWorkState: {
        ...state.workState,
        status: "needs_user_input",
        summary: request.summary,
        userInputNeeded: request.response,
        nextStep: request.response,
      },
    };
  }

  if (request.outcome === "blocked") {
    if (!hasBlockingEvidence(state)) {
      return rejectedValidation("A blocked outcome requires an authoritative blocker or failed verification in the current run.");
    }
    return {
      accepted: true,
      outcome: request.outcome,
      response: request.response,
      nextWorkState: {
        ...state.workState,
        status: "blocked",
        summary: request.summary,
        blockers: normalizeStrings([
          ...(state.workState.blockers ?? []),
          latestFailureReason(state) ?? request.summary,
        ]).slice(0, 8),
        nextStep: undefined,
      },
    };
  }

  if (!hasFailureEvidence(state)) {
    return rejectedValidation("A failed outcome requires a failed tool, verification, deterministic gate result, or provider/runtime failure in the current run.");
  }
  return {
    accepted: true,
    outcome: request.outcome,
    response: request.response,
    nextWorkState: {
      ...state.workState,
      status: "not_done",
      summary: request.summary,
      openWork: normalizeStrings([
        ...(state.workState.openWork ?? []),
        latestFailureReason(state) ?? request.summary,
      ]).slice(0, 8),
    },
  };
}

function normalizeValidationRequest(request: ValidationRequest): ValidationRequest {
  return {
    outcome: request.outcome,
    summary: normalizeText(request.summary),
    response: request.response.trim(),
    ...(request.resources ? { resources: request.resources } : {}),
  };
}

function rejectedValidation(message: string): VirtualValidationResult {
  return {
    accepted: false,
    repair: createVirtualModeRepair(
      "VALIDATION_EVIDENCE_MISSING",
      message,
      [],
      ["Continue in the current mode to gather or repair evidence, then call decision_validate again."],
    ),
  };
}

function hasSuccessfulObservationEvidence(state: LoopState): boolean {
  return state.completedSteps.some((step) =>
    step.outcome === "success"
    && step.validationStatus !== "failed"
    && step.expectationCheckStatus !== "failed"
    && (step.toolSuccessCount ?? 0) > 0
    && (step.toolsUsed ?? []).some((tool) =>
      isObservationalTool(tool) && !isWorkstreamRoutingObservationTool(tool)));
}

function canValidateNeedsUserInput(state: LoopState): boolean {
  return hasSuccessfulObservationEvidence(state)
    || hasFailureEvidence(state)
    || state.virtualMode.targets.length === 0;
}

function hasBlockingEvidence(state: LoopState): boolean {
  return (state.workState.blockers ?? []).some(Boolean)
    || state.failureHistory.some((failure) =>
      failure.failureType === "permission"
      || failure.failureType === "missing_path"
      || failure.failureType === "verify_failed")
    || state.completedSteps.some((step) => step.outcome === "failed");
}

function hasFailureEvidence(state: LoopState): boolean {
  return state.failureHistory.length > 0
    || state.completedSteps.some((step) => step.outcome === "failed")
    || (state.toolContext?.toolCalls ?? []).some((call) => call.status === "failed");
}

function latestFailureReason(state: LoopState): string | undefined {
  return state.failureHistory[state.failureHistory.length - 1]?.reason
    ?? [...state.completedSteps].reverse().find((step) => step.outcome === "failed")?.summary;
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
