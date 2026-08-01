export const TASK_VALIDATION_OUTCOME_KINDS = [
  "path.exists",
  "path.missing",
  "file.search_match",
  "file.search_no_match",
  "file.search_count",
  "file.read_complete",
  "file.read_scope_satisfied",
  "file.written",
  "file.patched",
  "path.copied",
  "file.permissions_set",
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

export type ValidationExpectedPathKind =
  | "file"
  | "directory"
  | "symlink"
  | "either";
export type ValidationCheckStatus = "pending" | "passed" | "failed";

export type FileSearchEntryKind = "file" | "directory" | "symlink" | "any";

export interface FileSearchValidationScope {
  roots: string[];
  maxDepth: number;
  includeHidden: boolean;
  entryKind: FileSearchEntryKind;
}

export interface FileSearchMatchValidation {
  query: string;
  line: number;
  caseSensitive: boolean;
}

export interface FileSearchCountValidation {
  query: string;
  roots: string[];
  maxDepth: number;
  includeHidden: boolean;
  caseSensitive: boolean;
  countUnit: "occurrences";
  totalMatchCount: number;
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
 * One exact responsibility outcome resolved by the runtime for final task
 * validation.
 *
 * Model-facing transitions select only outcomeRef values. The remaining fields
 * are materialized from deterministic current-run verification.
 */
export interface ModeTransitionValidationCheck {
  outcomeRef?: string;
  kind: TaskValidationOutcomeKind;
  subject: string;
  expectedKind?: ValidationExpectedPathKind;
  modeOctal?: string;
  modeSymbolic?: string;
  searchMatch?: FileSearchMatchValidation;
  searchCount?: FileSearchCountValidation;
  searchScope?: FileSearchValidationScope;
  readScope?: FileReadValidationScope;
  denialCode?: string;
}

/**
 * Bounded semantic metadata proposed by the model for one exact verified
 * filesystem resource. Identity, locator, kind, version, and lifecycle remain
 * deterministic runtime facts.
 */
export interface ResourceMetadataProposal {
  path: string;
  displayName: string;
  description: string;
  aliases: string[];
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
    || kind === "file.search_match"
    || kind === "file.read_complete"
    || kind === "file.read_scope_satisfied"
    || kind === "file.written"
    || kind === "file.patched"
    || kind === "path.copied"
    || kind === "file.permissions_set"
    || kind === "directory.created"
    || kind === "path.moved_from"
    || kind === "path.moved_to"
    || kind === "path.deleted";
}
