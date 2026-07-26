import type {
  FileReadValidationScope,
  FileSearchValidationScope,
  TaskValidationOutcomeKind,
  ValidationCheckResult,
} from "../task-validation-contracts.js";
import {
  WORK_STATE_LIMITS,
  type ImportantContextItem,
} from "./contracts.js";

export const MAX_VALIDATION_COMPLETION_RECEIPTS = 4;

const ARTIFACT_OUTCOMES = new Set<TaskValidationOutcomeKind>([
  "file.written",
  "file.patched",
  "directory.created",
  "path.moved_to",
  "artifact.available",
]);

export function mergeValidationCompletionReceipts(input: {
  runId: string;
  importantContext: ImportantContextItem[];
  checks: ValidationCheckResult[];
}): ImportantContextItem[] {
  const existing = uniqueContext(input.importantContext);
  const receipts = buildValidationCompletionReceipts({
    runId: input.runId,
    checks: input.checks,
  }).filter((receipt) => !existing.some((item) => sameContext(item, receipt)));
  if (receipts.length === 0) {
    return existing.slice(0, WORK_STATE_LIMITS.importantContextItems);
  }

  const existingLimit = Math.max(
    0,
    WORK_STATE_LIMITS.importantContextItems - receipts.length,
  );
  return [
    ...existing.slice(0, existingLimit),
    ...receipts,
  ];
}

export function buildValidationCompletionReceipts(input: {
  runId: string;
  checks: ValidationCheckResult[];
}): ImportantContextItem[] {
  const receipts: ImportantContextItem[] = [];
  for (const check of input.checks) {
    if (check.status !== "passed" || !check.satisfiedBy) {
      continue;
    }
    const ref = completionProofRef(input.runId, check.satisfiedBy);
    if (!ref) {
      continue;
    }
    const receipt: ImportantContextItem = {
      kind: ARTIFACT_OUTCOMES.has(check.kind) ? "artifact" : "finding",
      value: completionReceiptValue(check),
      ref,
    };
    if (receipts.some((candidate) => sameContext(candidate, receipt))) {
      continue;
    }
    receipts.push(receipt);
    if (receipts.length >= MAX_VALIDATION_COMPLETION_RECEIPTS) {
      break;
    }
  }
  return receipts;
}

function completionReceiptValue(check: ValidationCheckResult): string {
  const subject = normalized(check.subject);
  switch (check.kind) {
    case "path.exists":
      return bounded(
        `Verified that ${subject} exists${check.actualKind ? ` as a ${check.actualKind}` : ""}.`,
      );
    case "path.missing":
      return bounded(`Verified that ${subject} is absent.`);
    case "file.search_no_match":
      return bounded(searchScopeReceipt(subject, check.searchScope));
    case "file.read_complete":
      return bounded(`Verified a complete read of ${subject}.`);
    case "file.read_scope_satisfied":
      return bounded(readScopeReceipt(subject, check.readScope));
    case "file.written":
      return bounded(`Verified the written file ${subject}.`);
    case "file.patched":
      return bounded(`Verified the patched file ${subject}.`);
    case "directory.created":
      return bounded(`Verified the created directory ${subject}.`);
    case "path.moved_from":
      return bounded(`Verified the move from ${subject}.`);
    case "path.moved_to":
      return bounded(`Verified the moved destination ${subject}.`);
    case "path.deleted":
      return bounded(`Verified deletion of ${subject}.`);
    case "calculation.evaluated":
      return bounded(`Verified the calculated result ${subject}.`);
    case "database.read_succeeded":
      return bounded(`Verified the database read ${subject}.`);
    case "database.mutation_succeeded":
      return bounded(`Verified the database change ${subject}.`);
    case "pulse.action_completed":
      return bounded(`Verified the completed Pulse action ${subject}.`);
    case "process.exit_success":
      return bounded(`Verified successful process completion for ${subject}.`);
    case "python.execution_succeeded":
      return bounded(`Verified successful Python execution for ${subject}.`);
    case "memory.read_succeeded":
      return bounded(`Verified the memory read ${subject}.`);
    case "memory.change_succeeded":
      return bounded(`Verified the memory change ${subject}.`);
    case "system.time_observed":
      return bounded(`Verified a fresh time observation for ${subject}.`);
    case "system.health_observed":
      return bounded(`Verified a fresh system health observation for ${subject}.`);
    case "artifact.available":
      return bounded(`Verified the available artifact ${subject}.`);
    case "tool.call_succeeded":
      return bounded(`Verified successful completion of tool call ${subject}.`);
  }
}

function searchScopeReceipt(
  subject: string,
  scope: FileSearchValidationScope | undefined,
): string {
  if (!scope) {
    return `Verified no filename match for "${subject}".`;
  }
  return `Verified no filename match for "${subject}" under ${scope.roots.join(", ")}.`;
}

function readScopeReceipt(
  subject: string,
  scope: FileReadValidationScope | undefined,
): string {
  if (scope?.mode === "slice") {
    return `Verified a read of lines ${scope.startLine}-${scope.endLine} from ${subject}.`;
  }
  if (scope?.mode === "search") {
    return `Verified a search of ${subject} for "${normalized(scope.query)}".`;
  }
  if (scope?.mode === "profile") {
    return `Verified a profile read of ${subject}.`;
  }
  return `Verified the requested read scope for ${subject}.`;
}

function completionProofRef(
  runId: string,
  source: NonNullable<ValidationCheckResult["satisfiedBy"]>,
): string | undefined {
  const exact = source.ref?.trim();
  const candidate = exact || [
    `run:${normalized(runId)}`,
    `step:${source.step}`,
    ...(source.callId ? [`call:${normalized(source.callId)}`] : []),
  ].join(":");
  const normalizedCandidate = normalized(candidate);
  return normalizedCandidate.length <= WORK_STATE_LIMITS.importantContextRefChars
    ? normalizedCandidate
    : undefined;
}

function uniqueContext(items: ImportantContextItem[]): ImportantContextItem[] {
  const output: ImportantContextItem[] = [];
  for (const item of items) {
    const normalizedItem: ImportantContextItem = {
      kind: item.kind,
      value: bounded(item.value),
      ...(item.ref?.trim() ? { ref: boundedRef(item.ref) } : {}),
    };
    if (!normalizedItem.value || output.some((candidate) =>
      sameContext(candidate, normalizedItem))) {
      continue;
    }
    output.push(normalizedItem);
  }
  return output;
}

function sameContext(
  left: ImportantContextItem,
  right: ImportantContextItem,
): boolean {
  return left.kind === right.kind
    && normalized(left.value) === normalized(right.value)
    && normalized(left.ref ?? "") === normalized(right.ref ?? "");
}

function bounded(value: string): string {
  const text = normalized(value);
  const maximum = WORK_STATE_LIMITS.importantContextValueChars;
  if (text.length <= maximum) {
    return text;
  }
  return `${text.slice(0, maximum - 3).trimEnd()}...`;
}

function boundedRef(value: string): string {
  return normalized(value).slice(0, WORK_STATE_LIMITS.importantContextRefChars);
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
