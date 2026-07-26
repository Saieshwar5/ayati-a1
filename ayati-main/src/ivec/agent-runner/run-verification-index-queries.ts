import type {
  CurrentRunVerificationIndex,
  RunInvalidatedOutcome,
  RunVerifiedFileSearchOutcome,
  RunVerifiedFileReadOutcome,
  RunVerifiedOutcome,
  RunVerifiedPathOutcome,
} from "./run-verification-index-contracts.js";
import { readOutcomeSatisfiesScope } from "./run-verification-read-scope.js";
import type { ModeTransitionValidationCheck } from "./task-validation-contracts.js";
import {
  normalizeFileSearchValidationScope,
  normalizeTaskValidationSubject,
} from "./task-validation-outcome-registry.js";

export function findLatestVerifiedPathOutcome(
  index: CurrentRunVerificationIndex,
  path: string,
): RunVerifiedPathOutcome | undefined {
  const subject = normalizeTaskValidationSubject("path.exists", path);
  return latestOutcome(index.outcomes, (outcome): outcome is RunVerifiedPathOutcome => (
    outcome.family === "filesystem_path"
    && outcome.role === "completion"
    && outcome.subject === subject
  ));
}

export function findLatestVerifiedCompleteRead(
  index: CurrentRunVerificationIndex,
  path: string,
): RunVerifiedFileReadOutcome | undefined {
  const subject = normalizeTaskValidationSubject("file.read_complete", path);
  return latestOutcome(index.outcomes, (outcome): outcome is RunVerifiedFileReadOutcome => (
    outcome.family === "filesystem_read"
    && outcome.kind === "file.read_complete"
    && outcome.role === "completion"
    && outcome.subject === subject
  ));
}

export function findLatestInvalidatedCompleteRead(
  index: CurrentRunVerificationIndex,
  path: string,
): RunInvalidatedOutcome | undefined {
  const subject = normalizeTaskValidationSubject("file.read_complete", path);
  return latestInvalidated(index.invalidated, (entry) => (
    entry.outcome.family === "filesystem_read"
    && entry.outcome.kind === "file.read_complete"
    && entry.outcome.role === "completion"
    && entry.outcome.subject === subject
  ));
}

export function findLatestInvalidatedPathOutcome(
  index: CurrentRunVerificationIndex,
  path: string,
): RunInvalidatedOutcome | undefined {
  const subject = normalizeTaskValidationSubject("path.exists", path);
  return latestInvalidated(index.invalidated, (entry) => (
    entry.outcome.family === "filesystem_path"
    && entry.outcome.role === "completion"
    && entry.outcome.subject === subject
  ));
}

export function findLatestVerifiedOutcomeForCheck(
  index: CurrentRunVerificationIndex,
  check: ModeTransitionValidationCheck,
): RunVerifiedOutcome | undefined {
  const subject = normalizeTaskValidationSubject(check.kind, check.subject);
  return latestOutcome(index.outcomes, (outcome): outcome is RunVerifiedOutcome => {
    if (outcome.role !== "completion" || outcome.subject !== subject) {
      return false;
    }
    if (check.kind === "path.exists") {
      return outcome.family === "filesystem_path" && outcome.exists;
    }
    if (check.kind === "path.missing") {
      return outcome.family === "filesystem_path" && !outcome.exists;
    }
    if (check.kind === "file.read_complete") {
      return outcome.family === "filesystem_read"
        && outcome.kind === "file.read_complete";
    }
    if (check.kind === "file.search_no_match") {
      return outcome.family === "filesystem_search"
        && outcome.kind === "file.search_no_match"
        && check.searchScope !== undefined
        && sameSearchScope(outcome, check.searchScope);
    }
    if (check.kind === "file.read_scope_satisfied") {
      return outcome.family === "filesystem_read"
        && check.readScope !== undefined
        && readOutcomeSatisfiesScope(outcome, check.readScope);
    }
    if (
      check.kind === "file.written"
      || check.kind === "file.patched"
      || check.kind === "directory.created"
      || check.kind === "path.moved_from"
      || check.kind === "path.moved_to"
      || check.kind === "path.deleted"
    ) {
      return outcome.family === "filesystem_path"
        && outcome.kind === check.kind;
    }
    return outcome.family === "task" && outcome.kind === check.kind;
  });
}

export function findLatestInvalidatedOutcomeForCheck(
  index: CurrentRunVerificationIndex,
  check: ModeTransitionValidationCheck,
): RunInvalidatedOutcome | undefined {
  const subject = normalizeTaskValidationSubject(check.kind, check.subject);
  return latestInvalidated(index.invalidated, (entry) => {
    if (
      entry.outcome.role !== "completion"
      || entry.outcome.subject !== subject
    ) {
      return false;
    }
    if (check.kind === "file.read_complete") {
      return entry.outcome.family === "filesystem_read"
        && entry.outcome.kind === "file.read_complete";
    }
    if (check.kind === "file.search_no_match") {
      return entry.outcome.family === "filesystem_search"
        && entry.outcome.kind === "file.search_no_match"
        && check.searchScope !== undefined
        && sameSearchScope(entry.outcome, check.searchScope);
    }
    if (check.kind === "file.read_scope_satisfied") {
      return entry.outcome.family === "filesystem_read"
        && check.readScope !== undefined
        && readOutcomeSatisfiesScope(entry.outcome, check.readScope);
    }
    return entry.outcome.family === "filesystem_path";
  });
}

function sameSearchScope(
  outcome: RunVerifiedFileSearchOutcome,
  scope: NonNullable<ModeTransitionValidationCheck["searchScope"]>,
): boolean {
  return JSON.stringify(outcome.searchScope)
    === JSON.stringify(normalizeFileSearchValidationScope(scope));
}

function latestOutcome<T extends RunVerifiedOutcome>(
  outcomes: RunVerifiedOutcome[],
  predicate: (outcome: RunVerifiedOutcome) => outcome is T,
): T | undefined {
  return outcomes.filter(predicate).sort((a, b) => b.ordinal - a.ordinal)[0];
}

function latestInvalidated(
  entries: RunInvalidatedOutcome[],
  predicate: (entry: RunInvalidatedOutcome) => boolean,
): RunInvalidatedOutcome | undefined {
  return entries
    .filter(predicate)
    .sort((a, b) => b.outcome.ordinal - a.outcome.ordinal)[0];
}
