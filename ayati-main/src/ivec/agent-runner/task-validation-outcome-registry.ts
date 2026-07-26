import { isAbsolute, resolve } from "node:path";
import type { ArtifactRef } from "../../skills/types.js";
import { requireAbsoluteFilesystemPath } from "../../shared/filesystem-paths.js";
import type { ToolCallVerifiedFact } from "./tool-call-verification-contracts.js";
import {
  isFilesystemTaskValidationOutcomeKind,
  type FileReadValidationScope,
  type FileSearchValidationScope,
  type ModeTransitionValidationCheck,
  type TaskValidationOutcomeKind,
} from "./task-validation-contracts.js";

export interface RegisteredTaskOutcome {
  kind: TaskValidationOutcomeKind;
  subject: string;
  summary: string;
  factKind?: string;
  data?: Record<string, unknown>;
}

export interface TaskValidationCheckIssue {
  message: string;
  subject: string;
}

const VERIFIED_FACT_OUTCOMES: Readonly<Record<string, TaskValidationOutcomeKind>> = {
  calculation_evaluated: "calculation.evaluated",
  database_read: "database.read_succeeded",
  database_mutated: "database.mutation_succeeded",
  pulse_action_completed: "pulse.action_completed",
  process_exit_success: "process.exit_success",
  python_execution_succeeded: "python.execution_succeeded",
  memory_read_completed: "memory.read_succeeded",
  memory_change_completed: "memory.change_succeeded",
  system_time_observed: "system.time_observed",
  system_health_observed: "system.health_observed",
  artifact_registered: "artifact.available",
};

export function registeredTaskOutcomeFromFact(
  fact: ToolCallVerifiedFact,
): RegisteredTaskOutcome | undefined {
  const kind = VERIFIED_FACT_OUTCOMES[fact.kind];
  if (!kind) return undefined;
  const subject = factSubject(fact);
  if (!subject) return undefined;
  return {
    kind,
    subject,
    summary: fact.message,
    factKind: fact.kind,
    ...(fact.data ? { data: fact.data } : {}),
  };
}

export function registeredArtifactOutcome(
  artifact: ArtifactRef,
): RegisteredTaskOutcome | undefined {
  if (artifact.kind === "file" || artifact.kind === "directory") {
    return undefined;
  }
  const subject = artifact.path?.trim()
    || artifact.uri?.trim()
    || artifact.id?.trim();
  if (!subject) return undefined;
  return {
    kind: "artifact.available",
    subject,
    summary: `Verified ${artifact.kind} artifact ${subject} is available.`,
    data: {
      artifactKind: artifact.kind,
      ...(artifact.label ? { label: artifact.label } : {}),
    },
  };
}

export function normalizeTaskValidationCheck(
  check: ModeTransitionValidationCheck,
): ModeTransitionValidationCheck {
  return {
    kind: check.kind,
    subject: normalizeTaskValidationSubject(check.kind, check.subject),
    ...(check.expectedKind ? { expectedKind: check.expectedKind } : {}),
    ...(check.searchScope
      ? { searchScope: normalizeFileSearchValidationScope(check.searchScope) }
      : {}),
    ...(check.readScope
      ? { readScope: normalizeFileReadValidationScope(check.readScope) }
      : {}),
  };
}

export function validateTaskValidationCheck(
  check: ModeTransitionValidationCheck,
): TaskValidationCheckIssue | undefined {
  const subject = check.subject.trim();
  if (!subject) {
    return {
      message: `Validation outcome ${check.kind} requires an exact non-empty subject.`,
      subject,
    };
  }
  if (isFilesystemTaskValidationOutcomeKind(check.kind)) {
    const required = requireAbsoluteFilesystemPath(subject);
    if (!required.ok || !isAbsolute(required.absolutePath)) {
      return {
        message: `Filesystem validation outcome ${check.kind} requires a canonical absolute path subject.`,
        subject,
      };
    }
  } else if (check.expectedKind !== undefined) {
    return {
      message: `expectedKind is valid only for filesystem validation outcomes, not ${check.kind}.`,
      subject,
    };
  }

  if (check.kind === "file.search_no_match") {
    if (!check.searchScope) {
      return {
        message: "file.search_no_match requires one exact searchScope.",
        subject,
      };
    }
    const scopeIssue = validateFileSearchValidationScope(check.searchScope);
    if (scopeIssue) {
      return {
        message: scopeIssue,
        subject,
      };
    }
  } else if (check.searchScope !== undefined) {
    return {
      message: `searchScope is valid only for file.search_no_match, not ${check.kind}.`,
      subject,
    };
  }

  if (check.kind === "file.read_scope_satisfied") {
    if (!check.readScope) {
      return {
        message: "file.read_scope_satisfied requires one exact readScope.",
        subject,
      };
    }
    const scopeIssue = validateFileReadValidationScope(check.readScope);
    if (scopeIssue) {
      return {
        message: scopeIssue,
        subject,
      };
    }
  } else if (check.readScope !== undefined) {
    return {
      message: `readScope is valid only for file.read_scope_satisfied, not ${check.kind}.`,
      subject,
    };
  }
  return undefined;
}

export function normalizeFileSearchValidationScope(
  scope: FileSearchValidationScope,
): FileSearchValidationScope {
  const roots = scope.roots.map((root) => {
    const required = requireAbsoluteFilesystemPath(root.trim());
    return required.ok ? resolve(required.absolutePath) : root.trim();
  });
  return {
    roots: [...new Set(roots)].sort(),
    maxDepth: scope.maxDepth,
    includeHidden: scope.includeHidden,
  };
}

export function normalizeFileReadValidationScope(
  scope: FileReadValidationScope,
): FileReadValidationScope {
  if (scope.mode === "slice") {
    return {
      mode: "slice",
      startLine: scope.startLine,
      endLine: scope.endLine,
    };
  }
  if (scope.mode === "search") {
    return {
      mode: "search",
      query: scope.query.trim(),
    };
  }
  return { mode: "profile" };
}

export function normalizeTaskValidationSubject(
  kind: TaskValidationOutcomeKind,
  value: string,
): string {
  const trimmed = value.trim();
  if (!isFilesystemTaskValidationOutcomeKind(kind)) {
    return trimmed;
  }
  const required = requireAbsoluteFilesystemPath(trimmed);
  return required.ok ? resolve(required.absolutePath) : trimmed;
}

function factSubject(fact: ToolCallVerifiedFact): string | undefined {
  const explicit = fact.subject?.trim();
  if (explicit) return explicit;
  const value = fact.data?.["value"];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    typeof value === "number"
    || typeof value === "boolean"
  ) {
    return String(value);
  }
  return undefined;
}

function validateFileSearchValidationScope(
  scope: FileSearchValidationScope,
): string | undefined {
  if (scope.roots.length === 0) {
    return "Search scope requires at least one canonical absolute root.";
  }
  for (const root of scope.roots) {
    const required = requireAbsoluteFilesystemPath(root);
    if (!required.ok || !isAbsolute(required.absolutePath)) {
      return "Search scope roots must be canonical absolute paths.";
    }
  }
  if (!Number.isSafeInteger(scope.maxDepth) || scope.maxDepth < 1) {
    return "Search scope maxDepth must be a positive integer.";
  }
  if (typeof scope.includeHidden !== "boolean") {
    return "Search scope includeHidden must be a boolean.";
  }
  return undefined;
}

function validateFileReadValidationScope(
  scope: FileReadValidationScope,
): string | undefined {
  if (scope.mode === "slice") {
    if (
      !Number.isInteger(scope.startLine)
      || !Number.isInteger(scope.endLine)
      || scope.startLine < 1
      || scope.endLine < scope.startLine
    ) {
      return "Slice readScope requires positive integer startLine/endLine with endLine at or after startLine.";
    }
    return undefined;
  }
  if (scope.mode === "search") {
    return scope.query.trim()
      ? undefined
      : "Search readScope requires a non-empty query.";
  }
  if (scope.mode === "profile") {
    return undefined;
  }
  return "readScope mode must be slice, search, or profile.";
}
