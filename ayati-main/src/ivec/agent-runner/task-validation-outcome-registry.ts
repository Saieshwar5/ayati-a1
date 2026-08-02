import { resolve } from "node:path";
import type { ArtifactRef } from "../../skills/types.js";
import { requireAbsoluteFilesystemPath } from "../../shared/filesystem-paths.js";
import type { ToolCallVerifiedFact } from "./tool-call-verification-contracts.js";
import {
  isFilesystemTaskValidationOutcomeKind,
  type FileSearchCountValidation,
  type FileReadValidationScope,
  type FileSearchValidationScope,
  type TaskValidationOutcomeKind,
} from "./task-validation-contracts.js";

export interface RegisteredTaskOutcome {
  kind: TaskValidationOutcomeKind;
  subject: string;
  summary: string;
  factKind?: string;
  data?: Record<string, unknown>;
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
  workstream_snapshot_read: "workstream.snapshot_read",
  system_time_observed: "system.time_observed",
  system_health_observed: "system.health_observed",
  artifact_registered: "artifact.available",
};

/**
 * Workstream reads serve two independent purposes: they provide ownership
 * evidence for routing and a committed snapshot for read-only answers. Keep
 * the call routing-scoped, but allow only its exact snapshot fact to prove
 * that the snapshot was read.
 */
export function routingFactCanSatisfyTaskValidation(
  toolName: string,
  fact: ToolCallVerifiedFact,
): boolean {
  return toolName === "git_context_read_workstream"
    && fact.kind === "workstream_snapshot_read";
}

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
    entryKind: scope.entryKind,
  };
}

export function normalizeFileSearchCountValidation(
  count: FileSearchCountValidation,
): FileSearchCountValidation {
  return {
    query: count.query.trim(),
    roots: [...new Set(count.roots.map((root) => {
      const required = requireAbsoluteFilesystemPath(root.trim());
      return required.ok ? resolve(required.absolutePath) : root.trim();
    }))].sort(),
    maxDepth: count.maxDepth,
    includeHidden: count.includeHidden,
    caseSensitive: count.caseSensitive,
    countUnit: "occurrences",
    totalMatchCount: count.totalMatchCount,
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
