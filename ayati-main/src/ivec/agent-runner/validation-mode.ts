import type {
  ValidationCheckResult,
  ValidationExpectedPathKind,
  VirtualModeState,
} from "./virtual-mode.js";
import {
  findLatestInvalidatedOutcomeForCheck,
  findLatestVerifiedOutcomeForCheck,
  type CurrentRunVerificationIndex,
  type RunVerifiedOutcome,
} from "./run-verification-index.js";

export function applyValidationModeEvidence(
  mode: VirtualModeState,
  index: CurrentRunVerificationIndex,
): void {
  const progress = mode.active === "validation" ? mode.validation : undefined;
  if (!progress) return;

  for (const check of progress.checks) {
    evaluateCheck(check, index);
  }

  progress.status = progress.checks.every((check) => check.status === "passed")
    ? "passed"
    : "failed";
}

export function validationModePassed(mode: VirtualModeState | undefined): boolean {
  return mode?.active === "validation"
    && mode.validation?.status === "passed"
    && mode.validation.checks.length > 0
    && mode.validation.checks.every((check) => check.status === "passed");
}

function evaluateCheck(
  check: ValidationCheckResult,
  index: CurrentRunVerificationIndex,
): void {
  const outcome = findLatestVerifiedOutcomeForCheck(index, check);
  if (!outcome) {
    const invalidated = findLatestInvalidatedOutcomeForCheck(index, check);
    setFailed(
      check,
      invalidated
        ? invalidated.reason === "ancestor_removed"
          ? "A later verified deletion or move removed this subject or one of its ancestors."
          : "A later verified mutation invalidated the earlier completion proof."
        : `No verified current-run ${check.kind} outcome exists for the exact subject ${check.subject}.`,
    );
    return;
  }

  const actualKind = filesystemActualKind(outcome);
  if (
    check.expectedKind
    && !expectedKindMatches(check.expectedKind, actualKind)
  ) {
    setFailed(
      check,
      `Expected ${check.expectedKind}, but the verified outcome reported ${actualKind ?? "an unknown filesystem kind"}.`,
      actualKind,
    );
    return;
  }

  setPassed(
    check,
    outcome,
    completionMessage(check),
    actualKind,
  );
}

function filesystemActualKind(
  outcome: RunVerifiedOutcome,
): "file" | "directory" | "symlink" | undefined {
  if (outcome.family === "filesystem_read") return "file";
  if (
    outcome.family === "filesystem_search"
    && outcome.kind === "file.search_match"
  ) {
    return "file";
  }
  return outcome.family === "filesystem_path" ? outcome.actualKind : undefined;
}

function expectedKindMatches(
  expected: ValidationExpectedPathKind,
  actual: "file" | "directory" | "symlink" | undefined,
): boolean {
  return expected === "either"
    ? actual === "file" || actual === "directory" || actual === "symlink"
    : expected === actual;
}

function completionMessage(
  check: ValidationCheckResult,
): string {
  const kind = check.kind;
  if (kind === "file.read_complete") {
    return "Confirmed an already-verified current-run complete file read.";
  }
  if (kind === "file.search_match") {
    return "Confirmed an already-verified current-run file-content match.";
  }
  if (kind === "file.search_count") {
    return "Confirmed an already-verified complete file-content occurrence count.";
  }
  if (kind === "file.search_no_match") {
    const entryKind = check.searchScope?.entryKind;
    const target = entryKind === "file"
      ? "files"
      : entryKind === "directory"
        ? "directories"
        : entryKind === "symlink"
          ? "symbolic links"
          : "files, directories, or symbolic links";
    return `Confirmed an already-verified complete search with no matching ${target}.`;
  }
  if (kind === "file.read_scope_satisfied") {
    return "Confirmed the requested bounded file-read scope from current-run proof.";
  }
  if (kind === "tool.call_succeeded") {
    return "Confirmed the exact current-run tool call passed deterministic verification.";
  }
  if (kind === "tool.call_denied") {
    return "Confirmed the exact current-run tool call was deterministically denied without retrying it.";
  }
  return `Confirmed the already-verified current-run ${kind} outcome.`;
}

function setPassed(
  check: ValidationCheckResult,
  outcome: RunVerifiedOutcome,
  message: string,
  actualKind?: "file" | "directory" | "symlink",
): void {
  check.status = "passed";
  check.tool = outcome.source.tool;
  check.message = message;
  check.satisfiedBy = {
    step: outcome.source.step,
    ...(outcome.source.callId ? { callId: outcome.source.callId } : {}),
    tool: outcome.source.tool,
    ref: outcome.source.ref,
  };
  if (actualKind) {
    check.actualKind = actualKind;
  } else {
    delete check.actualKind;
  }
}

function setFailed(
  check: ValidationCheckResult,
  message: string,
  actualKind?: "file" | "directory" | "symlink",
): void {
  check.status = "failed";
  check.message = message;
  delete check.tool;
  delete check.satisfiedBy;
  if (actualKind) {
    check.actualKind = actualKind;
  } else {
    delete check.actualKind;
  }
}
