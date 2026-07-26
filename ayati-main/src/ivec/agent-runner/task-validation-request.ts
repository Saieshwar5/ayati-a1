import type { ModeTransitionValidationCheck } from "./task-validation-contracts.js";
import { validateTaskValidationCheck } from "./task-validation-outcome-registry.js";

export interface TaskValidationRequestIssue {
  message: string;
  subjects: string[];
  allowedNextActions: string[];
}

export function validateTaskValidationRequest(
  checks: ModeTransitionValidationCheck[] | undefined,
): TaskValidationRequestIssue | undefined {
  if ((checks?.length ?? 0) === 0) {
    return {
      message: "Validation mode requires at least one exact important responsibility outcome.",
      subjects: [],
      allowedNextActions: [
        "Provide only the few outcome kinds and exact subjects required to decide whether the current responsibility is complete.",
      ],
    };
  }

  for (const check of checks ?? []) {
    const issue = validateTaskValidationCheck(check);
    if (issue) {
      return {
        message: issue.message,
        subjects: [issue.subject].filter(Boolean),
        allowedNextActions: [
          "Copy the outcome kind and exact subject from deterministic current-run verification.",
        ],
      };
    }
  }
  return undefined;
}
