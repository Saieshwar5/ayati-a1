export interface TaskValidationRequestIssue {
  message: string;
  subjects: string[];
  allowedNextActions: string[];
}

export function validateTaskValidationRequest(
  outcomeRefs: string[] | undefined,
): TaskValidationRequestIssue | undefined {
  if ((outcomeRefs?.length ?? 0) === 0) {
    return {
      message: "Validation mode requires at least one exact current-run outcomeRef.",
      subjects: [],
      allowedNextActions: [
        "Select only the few exact outcomeRef values required to decide whether the current responsibility is complete.",
      ],
    };
  }

  if ((outcomeRefs?.length ?? 0) > 12) {
    return {
      message: "Validation mode accepts at most twelve outcomeRef values.",
      subjects: outcomeRefs ?? [],
      allowedNextActions: ["Select only the few outcomes that materially decide completion."],
    };
  }

  const empty = (outcomeRefs ?? []).find((outcomeRef) => !outcomeRef.trim());
  if (empty !== undefined) {
    return {
      message: "Every validation outcomeRef must be a non-empty exact reference.",
      subjects: [],
      allowedNextActions: ["Copy exact outcomeRef values from context.run.verifiedOutcomes."],
    };
  }

  const unique = new Set(outcomeRefs);
  if (unique.size !== outcomeRefs?.length) {
    return {
      message: "Validation outcomeRef values must be unique.",
      subjects: outcomeRefs ?? [],
      allowedNextActions: ["Remove duplicate outcomeRef values."],
    };
  }
  return undefined;
}
