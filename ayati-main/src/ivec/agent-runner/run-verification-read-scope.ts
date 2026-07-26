import type { FilesystemCompletionEvidence } from "./filesystem-completion-evidence-contracts.js";
import type { RunVerifiedFileReadOutcome } from "./run-verification-index-contracts.js";
import type { FileReadValidationScope } from "./task-validation-contracts.js";

type FileReadEvidence = Extract<
  FilesystemCompletionEvidence,
  { kind: "file_read" }
>;

export function verifiedReadScopeFromEvidence(
  evidence: FileReadEvidence,
): FileReadValidationScope | undefined {
  if (!evidence.contentAvailable || evidence.truncated === true) {
    return undefined;
  }
  if (
    evidence.mode === "slice"
    && isPositiveInteger(evidence.startLine)
    && isPositiveInteger(evidence.endLine)
    && evidence.endLine >= evidence.startLine
  ) {
    return {
      mode: "slice",
      startLine: evidence.startLine,
      endLine: evidence.endLine,
    };
  }
  if (
    evidence.mode === "search"
    && evidence.coverage === "search_matches"
    && evidence.query?.trim()
  ) {
    return {
      mode: "search",
      query: evidence.query.trim(),
    };
  }
  if (
    evidence.mode === "profile"
    && evidence.coverage === "profile"
  ) {
    return { mode: "profile" };
  }
  return undefined;
}

export function readOutcomeSatisfiesScope(
  outcome: RunVerifiedFileReadOutcome,
  required: FileReadValidationScope,
): boolean {
  if (outcome.kind === "file.read_complete") {
    return true;
  }
  const actual = outcome.readScope;
  if (!actual || actual.mode !== required.mode) {
    return false;
  }
  if (required.mode === "slice" && actual.mode === "slice") {
    return actual.startLine <= required.startLine
      && actual.endLine >= required.endLine;
  }
  if (required.mode === "search" && actual.mode === "search") {
    return actual.query === required.query;
  }
  return required.mode === "profile" && actual.mode === "profile";
}

function isPositiveInteger(value: number | undefined): value is number {
  return Number.isInteger(value) && (value ?? 0) > 0;
}
