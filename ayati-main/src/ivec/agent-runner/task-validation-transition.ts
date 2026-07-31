import type { RunToolCallContext } from "../types.js";
import {
  buildCurrentRunVerificationIndex,
  type CurrentRunVerificationIndex,
} from "./run-verification-index.js";
import { resolveValidationOutcomeRefs } from "./task-validation-outcome-selection.js";
import {
  createVirtualModeRepair,
  type ModeTransitionRequest,
  type VirtualModeRepair,
} from "./virtual-mode.js";

export type PreparedTaskValidationTransition =
  | {
      ok: true;
      request: ModeTransitionRequest;
      index: CurrentRunVerificationIndex;
    }
  | {
      ok: false;
      repair: VirtualModeRepair;
    };

export function prepareTaskValidationTransition(input: {
  runId: string;
  calls?: RunToolCallContext[];
  request: ModeTransitionRequest;
}): PreparedTaskValidationTransition {
  const index = buildCurrentRunVerificationIndex({
    runId: input.runId,
    calls: input.calls,
  });
  const selection = resolveValidationOutcomeRefs(
    index,
    input.request.outcomeRefs ?? [],
  );
  if (!selection.ok) {
    return {
      ok: false,
      repair: createVirtualModeRepair(
        "MODE_TARGET_UNVERIFIED",
        selection.message,
        [selection.outcomeRef],
        selection.allowedNextActions,
      ),
    };
  }

  const validationSubjects = new Set(selection.checks.map((check) => check.subject));
  const unmatchedMetadata = (input.request.resourceMetadata ?? [])
    .filter((metadata) => !validationSubjects.has(metadata.path))
    .map((metadata) => metadata.path);
  if (unmatchedMetadata.length > 0) {
    return {
      ok: false,
      repair: createVirtualModeRepair(
        "MODE_INPUT_INVALID",
        "Resource metadata must refer to an exact filesystem subject resolved from the selected outcomeRefs.",
        unmatchedMetadata,
        ["Remove unmatched metadata or select the exact verified filesystem outcomeRef."],
      ),
    };
  }

  return {
    ok: true,
    index,
    request: {
      ...input.request,
      validationChecks: selection.checks,
    },
  };
}
