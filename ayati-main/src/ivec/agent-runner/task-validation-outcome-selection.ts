import type {
  CurrentRunVerificationIndex,
  RunInvalidatedOutcome,
  RunVerifiedOutcome,
} from "./run-verification-index-contracts.js";
import type { ModeTransitionValidationCheck } from "./task-validation-contracts.js";
import {
  findCurrentCompletionOutcomeByRef,
  findInvalidatedCompletionOutcomeByRef,
} from "./run-verification-index-queries.js";

export type ValidationOutcomeSelectionResult =
  | {
      ok: true;
      checks: ModeTransitionValidationCheck[];
    }
  | {
      ok: false;
      message: string;
      outcomeRef: string;
      allowedNextActions: string[];
    };

export function resolveValidationOutcomeRefs(
  index: CurrentRunVerificationIndex,
  outcomeRefs: string[],
): ValidationOutcomeSelectionResult {
  const checks: ModeTransitionValidationCheck[] = [];
  for (const outcomeRef of outcomeRefs) {
    const outcome = findCurrentCompletionOutcomeByRef(index, outcomeRef);
    if (outcome) {
      const check = validationCheckFromOutcome(outcome);
      if (check) {
        checks.push(check);
        continue;
      }
    }

    const invalidated = findInvalidatedCompletionOutcomeByRef(index, outcomeRef);
    if (invalidated) {
      return invalidatedSelection(invalidated);
    }

    const ineligible = index.outcomes.find((candidate) => candidate.id === outcomeRef);
    if (ineligible) {
      return {
        ok: false,
        message: `Outcome reference ${outcomeRef} is ${ineligible.role} evidence and cannot prove task completion.`,
        outcomeRef,
        allowedNextActions: [
          "Select an exact completion outcomeRef from context.run.verifiedOutcomes.",
        ],
      };
    }

    return {
      ok: false,
      message: `No current-run completion outcome exists for outcomeRef ${outcomeRef}.`,
      outcomeRef,
      allowedNextActions: [
        "Copy an exact currently projected outcomeRef from context.run.verifiedOutcomes.",
        "If the required proof is missing, return to the appropriate work mode and produce it once.",
      ],
    };
  }
  return { ok: true, checks };
}

function validationCheckFromOutcome(
  outcome: RunVerifiedOutcome,
): ModeTransitionValidationCheck | undefined {
  if (!outcome.subject) return undefined;

  const base = {
    outcomeRef: outcome.id,
    subject: outcome.subject,
  };
  if (outcome.family === "filesystem_path") {
    return {
      ...base,
      kind: outcome.kind,
      ...(outcome.actualKind ? { expectedKind: outcome.actualKind } : {}),
    };
  }
  if (outcome.family === "filesystem_read") {
    if (outcome.kind === "file.read_complete") {
      return {
        ...base,
        kind: "file.read_complete",
        expectedKind: "file",
      };
    }
    if (outcome.readScope) {
      return {
        ...base,
        kind: "file.read_scope_satisfied",
        expectedKind: "file",
        readScope: outcome.readScope,
      };
    }
    return undefined;
  }
  if (outcome.family === "filesystem_search") {
    return {
      ...base,
      kind: "file.search_no_match",
      searchScope: outcome.searchScope,
    };
  }
  if (outcome.family === "tool_denial") {
    return {
      ...base,
      kind: "tool.call_denied",
      denialCode: outcome.denialCode,
    };
  }
  if (outcome.family === "task") {
    return {
      ...base,
      kind: outcome.kind,
    };
  }
  return undefined;
}

function invalidatedSelection(
  entry: RunInvalidatedOutcome,
): Extract<ValidationOutcomeSelectionResult, { ok: false }> {
  return {
    ok: false,
    message: entry.reason === "ancestor_removed"
      ? `Outcome reference ${entry.outcome.id} is stale because a later verified deletion or move removed its subject or an ancestor.`
      : `Outcome reference ${entry.outcome.id} is stale because a later verified mutation invalidated it.`,
    outcomeRef: entry.outcome.id,
    allowedNextActions: [
      "Return to the appropriate work mode and produce fresh proof for the current state.",
    ],
  };
}
