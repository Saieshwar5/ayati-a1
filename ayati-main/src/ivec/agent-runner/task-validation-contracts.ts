export const TASK_VALIDATION_OUTCOME_KINDS = [
  "path.exists",
  "path.missing",
  "file.search_no_match",
  "file.read_complete",
  "file.read_scope_satisfied",
  "file.written",
  "file.patched",
  "directory.created",
  "path.moved_from",
  "path.moved_to",
  "path.deleted",
  "calculation.evaluated",
  "database.read_succeeded",
  "database.mutation_succeeded",
  "pulse.action_completed",
  "process.exit_success",
  "python.execution_succeeded",
  "memory.read_succeeded",
  "memory.change_succeeded",
  "system.time_observed",
  "system.health_observed",
  "artifact.available",
  "tool.call_succeeded",
  "tool.call_denied",
] as const;

export type TaskValidationOutcomeKind =
  typeof TASK_VALIDATION_OUTCOME_KINDS[number];

export type ValidationExpectedPathKind = "file" | "directory" | "either";
export type ValidationCheckStatus = "pending" | "passed" | "failed";

export interface FileSearchValidationScope {
  roots: string[];
  maxDepth: number;
  includeHidden: boolean;
}

export type FileReadValidationScope =
  | {
      mode: "slice";
      startLine: number;
      endLine: number;
    }
  | {
      mode: "search";
      query: string;
    }
  | {
      mode: "profile";
    };

/**
 * One exact responsibility outcome selected for final task validation.
 *
 * The subject is copied from deterministic current-run verification:
 * a canonical path, verified fact subject, artifact identity, or exact call id.
 */
export interface ModeTransitionValidationCheck {
  kind: TaskValidationOutcomeKind;
  subject: string;
  expectedKind?: ValidationExpectedPathKind;
  searchScope?: FileSearchValidationScope;
  readScope?: FileReadValidationScope;
  denialCode?: string;
}

export interface ValidationCheckResult extends ModeTransitionValidationCheck {
  status: ValidationCheckStatus;
  actualKind?: Exclude<ValidationExpectedPathKind, "either">;
  message?: string;
  tool?: string;
  satisfiedBy?: {
    step: number;
    callId?: string;
    tool: string;
    ref?: string;
  };
}

export function isTaskValidationOutcomeKind(
  value: unknown,
): value is TaskValidationOutcomeKind {
  return typeof value === "string"
    && (TASK_VALIDATION_OUTCOME_KINDS as readonly string[]).includes(value);
}

export function isFilesystemTaskValidationOutcomeKind(
  kind: TaskValidationOutcomeKind,
): boolean {
  return kind === "path.exists"
    || kind === "path.missing"
    || kind === "file.read_complete"
    || kind === "file.read_scope_satisfied"
    || kind === "file.written"
    || kind === "file.patched"
    || kind === "directory.created"
    || kind === "path.moved_from"
    || kind === "path.moved_to"
    || kind === "path.deleted";
}
