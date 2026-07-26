import type {
  FilesystemReadCoverage,
  FilesystemReadMode,
} from "./filesystem-completion-evidence-contracts.js";
import type { ToolErrorCategory } from "../../skills/types.js";
import type {
  ToolCallVerificationMethod,
  ToolCallVerificationStatus,
} from "./tool-call-verification-contracts.js";
import type {
  FileReadValidationScope,
  FileSearchValidationScope,
  TaskValidationOutcomeKind,
} from "./task-validation-contracts.js";

export type RunVerificationCallScope = "task" | "routing";
export type RunVerifiedOutcomeRole = "completion" | "supporting" | "routing";

export interface RunVerificationSource {
  runId: string;
  step: number;
  callId?: string;
  tool: string;
  ref: string;
  evidenceRef?: string;
}

export interface RunVerificationCallReceipt {
  source: RunVerificationSource;
  scope: RunVerificationCallScope;
  status: ToolCallVerificationStatus;
  method?: ToolCallVerificationMethod | "legacy";
  summary: string;
  code?: string;
  errorCategory?: ToolErrorCategory;
  errorTarget?: string;
}

interface RunVerifiedOutcomeBase {
  id: string;
  ordinal: number;
  role: RunVerifiedOutcomeRole;
  subject?: string;
  summary: string;
  source: RunVerificationSource;
}

export type RunVerifiedPathOutcomeKind =
  | "path.exists"
  | "path.missing"
  | "file.written"
  | "file.patched"
  | "directory.created"
  | "path.moved_from"
  | "path.moved_to"
  | "path.deleted";

export interface RunVerifiedPathOutcome extends RunVerifiedOutcomeBase {
  family: "filesystem_path";
  kind: RunVerifiedPathOutcomeKind;
  subject: string;
  exists: boolean;
  actualKind?: "file" | "directory";
  change: "observed" | "mutated";
  operation:
    | "inspect"
    | "find"
    | "read"
    | "list"
    | "write"
    | "patch"
    | "create"
    | "move"
    | "delete";
  requestedPath?: string;
}

export interface RunVerifiedFileReadOutcome extends RunVerifiedOutcomeBase {
  family: "filesystem_read";
  kind: "file.read_complete" | "file.read_partial";
  subject: string;
  requestedPath: string;
  coverage: FilesystemReadCoverage;
  contentAvailable: boolean;
  mode?: FilesystemReadMode;
  truncated?: boolean;
  lineCountKnown?: boolean;
  readScope?: FileReadValidationScope;
  matchCount?: number;
  sizeBytes?: number;
  lineCount?: number;
  sha256?: string;
}

export interface RunVerifiedFileSearchOutcome extends RunVerifiedOutcomeBase {
  family: "filesystem_search";
  kind: "file.search_no_match";
  subject: string;
  searchScope: FileSearchValidationScope;
  matchCount: 0;
  capped: false;
  errorCount: 0;
  depthLimitedDirectoryCount: 0;
  complete: true;
}

export interface RunVerifiedFactOutcome extends RunVerifiedOutcomeBase {
  family: "verified_fact";
  kind: "tool.verified_fact";
  factKind: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface RunVerifiedTaskOutcome extends RunVerifiedOutcomeBase {
  family: "task";
  kind: TaskValidationOutcomeKind;
  subject: string;
  factKind?: string;
  artifactKind?: string;
  data?: Record<string, unknown>;
}

export interface RunVerifiedToolDenialOutcome extends RunVerifiedOutcomeBase {
  family: "tool_denial";
  kind: "tool.call_denied";
  subject: string;
  denialCode: string;
  tool: string;
  target?: string;
}

export type RunVerifiedOutcome =
  | RunVerifiedPathOutcome
  | RunVerifiedFileReadOutcome
  | RunVerifiedFileSearchOutcome
  | RunVerifiedFactOutcome
  | RunVerifiedTaskOutcome
  | RunVerifiedToolDenialOutcome;

export type RunVerifiedOutcomeInvalidationReason =
  | "later_mutation"
  | "ancestor_removed";

export interface RunInvalidatedOutcome {
  outcome: RunVerifiedOutcome;
  reason: RunVerifiedOutcomeInvalidationReason;
  invalidatedBy: RunVerificationSource;
}

export interface RunVerificationExcludedCall {
  step: number;
  callId?: string;
  tool: string;
  reason: "different_run" | "invalid_step_reference";
  referencedRunId?: string;
}

export interface RunVerificationIndexSummary {
  totalCalls: number;
  passedCalls: number;
  failedCalls: number;
  notAvailableCalls: number;
  currentOutcomes: number;
  completionOutcomes: number;
  supportingOutcomes: number;
  routingOutcomes: number;
  invalidatedOutcomes: number;
  excludedCalls: number;
}

export interface CurrentRunVerificationIndex {
  version: 1;
  runId: string;
  throughStep: number;
  calls: RunVerificationCallReceipt[];
  outcomes: RunVerifiedOutcome[];
  invalidated: RunInvalidatedOutcome[];
  excluded: RunVerificationExcludedCall[];
  summary: RunVerificationIndexSummary;
}
