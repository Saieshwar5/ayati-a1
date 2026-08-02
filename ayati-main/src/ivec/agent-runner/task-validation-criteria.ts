import type {
  WorkstreamCompletionCriterion,
  WorkstreamCompletionProof,
} from "ayati-context-engine";
import type { LoopState } from "../types.js";
import type {
  ValidationCheckResult,
  ValidationCriterionProofSelection,
} from "./task-validation-contracts.js";
import { validationCompletionReceiptValue } from "./work-state/completion-receipts.js";

export interface ValidationCriterionProofIssue {
  message: string;
  subjects: string[];
  allowedNextActions: string[];
}

export function validateCriterionProofSelections(input: {
  acceptance: readonly string[];
  outcomeRefs: readonly string[];
  selections: readonly ValidationCriterionProofSelection[];
}): ValidationCriterionProofIssue | undefined {
  if (input.acceptance.length === 0) {
    return input.selections.length === 0
      ? undefined
      : issue(
        "Criterion proof mappings are valid only for a bound request with acceptance criteria.",
        input.selections.map((selection) => String(selection.criterionIndex)),
        ["Remove criterionProofs and validate the selected outcomeRefs directly."],
      );
  }
  if (input.selections.length === 0) {
    return issue(
      "Validation of a bound request must map every acceptance criterion to verified outcomeRefs.",
      input.acceptance.map((_, index) => String(index)),
      ["Add one criterionProofs entry for every zero-based acceptance criterion index in the active request."],
    );
  }

  const selectedRefs = new Set(input.outcomeRefs);
  const seenCriteria = new Set<number>();
  for (const selection of input.selections) {
    if (
      !Number.isSafeInteger(selection.criterionIndex)
      || selection.criterionIndex < 0
      || selection.criterionIndex >= input.acceptance.length
    ) {
      return issue(
        `Criterion index ${selection.criterionIndex} is outside the active request acceptance list.`,
        [String(selection.criterionIndex)],
        [`Use zero-based criterion indexes 0-${input.acceptance.length - 1}.`],
      );
    }
    if (seenCriteria.has(selection.criterionIndex)) {
      return issue(
        `Criterion index ${selection.criterionIndex} is mapped more than once.`,
        [String(selection.criterionIndex)],
        ["Combine that criterion's proof refs into one criterionProofs entry."],
      );
    }
    seenCriteria.add(selection.criterionIndex);
    if (selection.outcomeRefs.length === 0 || selection.outcomeRefs.length > 12) {
      return issue(
        `Criterion index ${selection.criterionIndex} must select between one and twelve outcomeRefs.`,
        selection.outcomeRefs,
        ["Select only the few verified outcomes that materially prove this criterion."],
      );
    }
    if (new Set(selection.outcomeRefs).size !== selection.outcomeRefs.length) {
      return issue(
        `Criterion index ${selection.criterionIndex} contains duplicate outcomeRefs.`,
        selection.outcomeRefs,
        ["Remove duplicate proof references."],
      );
    }
    const unknown = selection.outcomeRefs.filter((outcomeRef) => !selectedRefs.has(outcomeRef));
    if (unknown.length > 0) {
      return issue(
        `Criterion index ${selection.criterionIndex} refers to outcomes not selected for validation.`,
        unknown,
        ["Use only exact refs already included in this decision's outcomeRefs."],
      );
    }
  }

  const missing = input.acceptance
    .map((_, index) => index)
    .filter((index) => !seenCriteria.has(index));
  return missing.length === 0
    ? undefined
    : issue(
      `Criterion proof mappings are missing acceptance indexes: ${missing.join(", ")}.`,
      missing.map(String),
      ["Add one criterionProofs entry for every missing acceptance criterion."],
    );
}

export function selectedWorkstreamAcceptance(state: LoopState): string[] {
  const context = state.harnessContext.contextEngine;
  if (context?.current.routing?.status !== "bound") return [];
  const request = context.workstream?.selectedRequest ?? context.workstream?.currentRequest;
  if (!request || request.id !== context.current.routing.requestId) return [];
  return [...request.acceptance];
}

export function buildValidatedWorkstreamCriteria(
  state: LoopState,
): WorkstreamCompletionCriterion[] {
  const acceptance = selectedWorkstreamAcceptance(state);
  const validation = state.virtualMode.validation;
  if (acceptance.length === 0) return [];
  const selections = new Map(
    (validation?.criterionProofs ?? []).map((selection) => [
      selection.criterionIndex,
      selection,
    ]),
  );
  const checks = new Map(
    (validation?.checks ?? []).flatMap((check) => (
      check.outcomeRef ? [[check.outcomeRef, check] as const] : []
    )),
  );
  return acceptance.map((criterion, criterionIndex) => {
    const selection = selections.get(criterionIndex);
    const selectedChecks = (selection?.outcomeRefs ?? [])
      .map((outcomeRef) => checks.get(outcomeRef))
      .filter((check): check is ValidationCheckResult => Boolean(check));
    const proofs = selectedChecks.flatMap(workstreamCompletionProof);
    const passed = selection !== undefined
      && selectedChecks.length === selection.outcomeRefs.length
      && proofs.length === selection.outcomeRefs.length;
    return {
      criterion,
      passed,
      ...(proofs.length > 0 ? { proofs } : {}),
    };
  });
}

function workstreamCompletionProof(
  check: ValidationCheckResult,
): WorkstreamCompletionProof[] {
  if (
    check.status !== "passed"
    || !check.outcomeRef
    || !check.satisfiedBy
  ) {
    return [];
  }
  return [{
    outcomeRef: check.outcomeRef,
    kind: check.kind,
    subject: check.subject,
    summary: validationCompletionReceiptValue(check),
    source: {
      step: check.satisfiedBy.step,
      ...(check.satisfiedBy.callId ? { callId: check.satisfiedBy.callId } : {}),
      tool: check.satisfiedBy.tool,
      ...(check.satisfiedBy.ref ? { ref: check.satisfiedBy.ref } : {}),
    },
  }];
}

function issue(
  message: string,
  subjects: string[],
  allowedNextActions: string[],
): ValidationCriterionProofIssue {
  return { message, subjects, allowedNextActions };
}
