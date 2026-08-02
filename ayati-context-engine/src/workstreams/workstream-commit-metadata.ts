import { ContextEngineServiceError } from "../errors.js";
import { RUN_FINALIZATION_LIMITS } from "../run-finalization-limits.js";
import { requireRequestId, requireWorkstreamId } from "./workstream-repository-layout.js";
import { requireSingleLine } from "./workstream-markdown.js";

export type WorkstreamCommitOutcome = "completed" | "incomplete" | "blocked" | "failed";
export type WorkstreamCommitValidation =
  | "passed"
  | "failed"
  | "pending"
  | "not_required"
  | "not_applicable";
export type WorkstreamCommitRequestStatus = "queued" | "active" | "blocked" | "done" | "dropped";
export type WorkstreamCommitMutationType =
  | "created"
  | "modified"
  | "moved"
  | "deleted"
  | "restored"
  | "downloaded"
  | "external_state_changed";

export interface WorkstreamCommitMutation {
  type: WorkstreamCommitMutationType;
  resourceId: string;
  summary: string;
}

export interface WorkstreamCommitCriteria {
  passed: number;
  total: number;
}

export type WorkstreamCommitResourceEffects = Record<WorkstreamCommitMutationType, number>;

export interface WorkstreamIdentityCommitInput {
  subject: string;
  workstreamId: string;
  requestId: string;
  workstreamTitle?: string;
  requestTitle?: string;
  requestStatusAfter?: WorkstreamCommitRequestStatus;
}

export interface WorkstreamCommitInput extends WorkstreamIdentityCommitInput {
  runId: string;
  streamId: string;
  outcome: WorkstreamCommitOutcome;
  stopReason?: string;
  validation: WorkstreamCommitValidation;
  criteria?: WorkstreamCommitCriteria;
  resourceEffects?: WorkstreamCommitResourceEffects;
  mutationDetails?: WorkstreamCommitMutation[];
  problemCodes?: string[];
  summary: string;
  next?: string;
  messageHash: string;
  mutations: number;
}

export type WorkstreamCommitMetadata =
  | {
      event: "workstream_created";
      subject: string;
      workstreamId: string;
      requestId: string;
      outcome: "created";
      workstreamTitle?: string;
      requestTitle?: string;
      requestStatusAfter?: WorkstreamCommitRequestStatus;
      schema: "workstream/v3" | "workstream-commit/v1";
    }
  | {
      event: "workstream_bound_run_finalized";
      subject: string;
      workstreamId: string;
      requestId: string;
      runId: string;
      streamId: string;
      outcome: WorkstreamCommitOutcome;
      validation: WorkstreamCommitValidation;
      workstreamTitle?: string;
      requestTitle?: string;
      requestStatusAfter?: WorkstreamCommitRequestStatus;
      stopReason?: string;
      criteria?: WorkstreamCommitCriteria;
      resourceEffects?: WorkstreamCommitResourceEffects;
      mutationDetails: WorkstreamCommitMutation[];
      problemCodes: string[];
      summary: string;
      next?: string;
      messageHash: string;
      mutations: number;
      schema: "workstream/v3" | "workstream-commit/v1";
    };

const LEGACY_SCHEMA = "workstream/v3";
const COMMIT_SCHEMA = "workstream-commit/v1";
const MUTATION_TYPES: WorkstreamCommitMutationType[] = [
  "created",
  "modified",
  "moved",
  "deleted",
  "restored",
  "downloaded",
  "external_state_changed",
];

export function renderWorkstreamIdentityCommit(input: WorkstreamIdentityCommitInput): string {
  return [
    subject(input.subject),
    "",
    "Workstream: " + requireWorkstreamId(input.workstreamId),
    ...(input.workstreamTitle ? ["Workstream-Title: " + boundedLine(input.workstreamTitle, "Workstream-Title", 120)] : []),
    "Request: " + requireRequestId(input.requestId),
    ...(input.requestTitle ? ["Request-Title: " + boundedLine(input.requestTitle, "Request-Title", 120)] : []),
    ...(input.requestStatusAfter ? ["Request-Status-After: " + requestStatus(input.requestStatusAfter)] : []),
    "Outcome: created",
    "Ayati-Schema: " + COMMIT_SCHEMA,
    "Ayati-Event: workstream_created",
  ].join("\n");
}

export function renderWorkstreamCommit(input: WorkstreamCommitInput): string {
  const lines = [
    subject(input.subject),
    "",
    "Workstream: " + requireWorkstreamId(input.workstreamId),
    ...(input.workstreamTitle ? ["Workstream-Title: " + boundedLine(input.workstreamTitle, "Workstream-Title", 120)] : []),
    "Request: " + requireRequestId(input.requestId),
    ...(input.requestTitle ? ["Request-Title: " + boundedLine(input.requestTitle, "Request-Title", 120)] : []),
    ...(input.requestStatusAfter ? ["Request-Status-After: " + requestStatus(input.requestStatusAfter)] : []),
    "Run: " + identity(input.runId, "Run"),
    "Agent-Stream: " + identity(input.streamId, "Agent-Stream"),
    "Outcome: " + outcome(input.outcome),
    ...(input.stopReason ? ["Stop-Reason: " + stopReason(input.stopReason)] : []),
    "Validation: " + validation(input.validation),
    ...(input.criteria ? ["Criteria: " + criteria(input.criteria)] : []),
    ...(input.resourceEffects ? ["Resource-Effects: " + resourceEffects(input.resourceEffects)] : []),
    ...(input.mutationDetails ?? []).map((mutation) => "Mutation: " + renderMutation(mutation)),
    ...(input.problemCodes ?? []).map((code) => "Problem-Code: " + problemCode(code)),
    "Summary: " + boundedLine(
      input.summary,
      "Summary",
      RUN_FINALIZATION_LIMITS.summaryChars,
    ),
    ...(input.next ? ["Next: " + boundedLine(
      input.next,
      "Next",
      RUN_FINALIZATION_LIMITS.nextChars,
    )] : []),
    "Message-Hash: " + hash(input.messageHash),
    "Ayati-Schema: " + COMMIT_SCHEMA,
    "Ayati-Event: workstream_bound_run_finalized",
    "",
    "Ayati-Workstream: " + requireWorkstreamId(input.workstreamId),
    "Ayati-Request: " + requireRequestId(input.requestId),
    "Ayati-Run: " + identity(input.runId, "Ayati-Run"),
    "Ayati-Outcome: " + outcome(input.outcome),
    "Ayati-Mutations: " + mutationCount(input.mutations),
  ];
  return lines.join("\n");
}

export function parseWorkstreamCommit(message: string): WorkstreamCommitMetadata | undefined {
  const lines = message.replaceAll("\r\n", "\n").trim().split("\n");
  const commitSubject = lines[0]?.trim();
  if (!commitSubject) return undefined;
  const { fields, repeated } = parseFields(lines.slice(1));
  const event = fields["Ayati-Event"];
  if (!event) return undefined;
  const schema = fields["Ayati-Schema"];
  if (schema !== LEGACY_SCHEMA && schema !== COMMIT_SCHEMA) {
    invalid("Workstream commit contains an unsupported Ayati schema.", {
      schema: schema ?? null,
    });
  }
  const workstreamId = requireWorkstreamId(required(fields, "Workstream"));
  const requestId = requireRequestId(required(fields, "Request"));
  if (event === "workstream_created") {
    rejectUnsupportedFields(fields, IDENTITY_FIELDS);
    if (fields["Outcome"] !== "created") {
      invalid("Workstream identity commit outcome does not match its event.", { event });
    }
    return {
      event,
      subject: commitSubject,
      workstreamId,
      requestId,
      outcome: "created",
      ...(fields["Workstream-Title"] ? { workstreamTitle: boundedLine(fields["Workstream-Title"], "Workstream-Title", 120) } : {}),
      ...(fields["Request-Title"] ? { requestTitle: boundedLine(fields["Request-Title"], "Request-Title", 120) } : {}),
      ...(fields["Request-Status-After"] ? { requestStatusAfter: requestStatus(fields["Request-Status-After"]) } : {}),
      schema,
    };
  }
  if (event !== "workstream_bound_run_finalized") {
    invalid("Workstream commit contains an unsupported Ayati event.", { event });
  }
  rejectUnsupportedFields(fields, FINALIZATION_FIELDS);
  const parsed: WorkstreamCommitMetadata = {
    event,
    subject: commitSubject,
    workstreamId,
    requestId,
    runId: identity(required(fields, "Run"), "Run"),
    streamId: identity(required(fields, "Agent-Stream"), "Agent-Stream"),
    outcome: outcome(required(fields, "Outcome")),
    validation: validation(required(fields, "Validation")),
    ...(fields["Workstream-Title"] ? { workstreamTitle: boundedLine(fields["Workstream-Title"], "Workstream-Title", 120) } : {}),
    ...(fields["Request-Title"] ? { requestTitle: boundedLine(fields["Request-Title"], "Request-Title", 120) } : {}),
    ...(fields["Request-Status-After"] ? { requestStatusAfter: requestStatus(fields["Request-Status-After"]) } : {}),
    ...(fields["Stop-Reason"] ? { stopReason: stopReason(fields["Stop-Reason"]) } : {}),
    ...(fields["Criteria"] ? { criteria: parseCriteria(fields["Criteria"]) } : {}),
    ...(fields["Resource-Effects"] ? { resourceEffects: parseResourceEffects(fields["Resource-Effects"]) } : {}),
    mutationDetails: (repeated["Mutation"] ?? []).map(parseMutation),
    problemCodes: (repeated["Problem-Code"] ?? []).map(problemCode),
    summary: boundedLine(
      required(fields, "Summary"),
      "Summary",
      RUN_FINALIZATION_LIMITS.summaryChars,
    ),
    ...(fields["Next"] ? {
      next: boundedLine(fields["Next"], "Next", RUN_FINALIZATION_LIMITS.nextChars),
    } : {}),
    messageHash: hash(required(fields, "Message-Hash")),
    mutations: parseMutationCount(required(fields, "Ayati-Mutations")),
    schema,
  };
  if (parsed.mutationDetails.length > 0 && parsed.mutations !== parsed.mutationDetails.length) {
    invalid("Workstream commit mutation details do not match the mutation count.");
  }
  if (fields["Ayati-Workstream"] !== workstreamId
    || fields["Ayati-Request"] !== requestId
    || fields["Ayati-Run"] !== parsed.runId
    || fields["Ayati-Outcome"] !== parsed.outcome) {
    invalid("Workstream commit trailers do not match their readable metadata.");
  }
  return parsed;
}

function parseFields(lines: string[]): {
  fields: Record<string, string>;
  repeated: Record<string, string[]>;
} {
  const fields: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z][A-Za-z-]*):\s*(.+)$/);
    if (!match?.[1] || !match[2]) {
      invalid("Workstream commit contains an invalid metadata line.");
    }
    const key = match[1];
    const value = match[2].trim();
    if (key === "Mutation" || key === "Problem-Code") {
      repeated[key] = [...(repeated[key] ?? []), value];
      continue;
    }
    if (fields[key] !== undefined) {
      invalid("Workstream commit contains duplicate metadata.", { field: match[1] });
    }
    fields[key] = value;
  }
  return { fields, repeated };
}

const IDENTITY_FIELDS = new Set([
  "Workstream",
  "Workstream-Title",
  "Request",
  "Request-Title",
  "Request-Status-After",
  "Outcome",
  "Ayati-Schema",
  "Ayati-Event",
]);

const FINALIZATION_FIELDS = new Set([
  ...IDENTITY_FIELDS,
  "Run",
  "Agent-Stream",
  "Stop-Reason",
  "Validation",
  "Criteria",
  "Resource-Effects",
  "Mutation",
  "Problem-Code",
  "Summary",
  "Next",
  "Message-Hash",
  "Ayati-Workstream",
  "Ayati-Request",
  "Ayati-Run",
  "Ayati-Outcome",
  "Ayati-Mutations",
]);

function rejectUnsupportedFields(
  fields: Record<string, string>,
  allowed: ReadonlySet<string>,
): void {
  const unsupported = Object.keys(fields).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) {
    invalid("Workstream commit contains unsupported metadata.", { unsupportedFields: unsupported });
  }
}

function required(fields: Record<string, string>, field: string): string {
  const value = fields[field];
  if (!value) invalid("Workstream commit is missing required metadata.", { field });
  return value;
}

function subject(value: string): string {
  const normalized = requireSingleLine(value, "commit subject")
    .replace(/[.!?]+$/, "")
    .toLowerCase();
  if (normalized.length > 72) {
    invalid("Workstream commit subject may contain at most 72 characters.");
  }
  return normalized;
}

function identity(value: string, field: string): string {
  const normalized = requireSingleLine(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(normalized)) {
    invalid("Workstream commit identity field is invalid.", { field });
  }
  return normalized;
}

function outcome(value: string): WorkstreamCommitOutcome {
  if (value === "completed" || value === "incomplete" || value === "blocked"
    || value === "failed") {
    return value;
  }
  invalid("Workstream-bound run commit outcome is invalid.", { value });
}

function validation(value: string): WorkstreamCommitValidation {
  if (value === "passed" || value === "failed" || value === "pending"
    || value === "not_required" || value === "not_applicable") {
    return value;
  }
  invalid("Workstream-bound run commit validation is invalid.", { value });
}

function requestStatus(value: string): WorkstreamCommitRequestStatus {
  if (value === "queued" || value === "active" || value === "blocked"
    || value === "done" || value === "dropped") {
    return value;
  }
  invalid("Workstream commit request status is invalid.", { value });
}

function stopReason(value: string): string {
  const normalized = requireSingleLine(value, "Stop-Reason");
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(normalized)) {
    invalid("Workstream commit stop reason is invalid.", { value });
  }
  return normalized;
}

function criteria(value: WorkstreamCommitCriteria): string {
  if (!Number.isSafeInteger(value.passed) || value.passed < 0
    || !Number.isSafeInteger(value.total) || value.total < 0
    || value.passed > value.total) {
    invalid("Workstream commit criteria counts are invalid.");
  }
  return `passed=${value.passed} total=${value.total}`;
}

function parseCriteria(value: string): WorkstreamCommitCriteria {
  const match = /^passed=(\d+) total=(\d+)$/.exec(value);
  if (!match) invalid("Workstream commit criteria metadata is invalid.");
  const result = { passed: Number(match[1]), total: Number(match[2]) };
  criteria(result);
  return result;
}

function resourceEffects(value: WorkstreamCommitResourceEffects): string {
  return MUTATION_TYPES.map((type) => {
    const count = value[type];
    if (!Number.isSafeInteger(count) || count < 0) {
      invalid("Workstream commit resource effect count is invalid.", { type, count });
    }
    return `${type}=${count}`;
  }).join(" ");
}

function parseResourceEffects(value: string): WorkstreamCommitResourceEffects {
  const parts = Object.fromEntries(value.split(" ").map((part) => {
    const match = /^([a-z_]+)=(\d+)$/.exec(part);
    if (!match) invalid("Workstream commit resource effects are invalid.");
    return [match[1], Number(match[2])];
  }));
  const unexpected = Object.keys(parts).filter(
    (type) => !MUTATION_TYPES.includes(type as WorkstreamCommitMutationType),
  );
  if (unexpected.length > 0 || MUTATION_TYPES.some((type) => parts[type] === undefined)) {
    invalid("Workstream commit resource effects are incomplete or unsupported.", { unexpected });
  }
  const result = Object.fromEntries(
    MUTATION_TYPES.map((type) => [type, parts[type]]),
  ) as WorkstreamCommitResourceEffects;
  resourceEffects(result);
  return result;
}

function renderMutation(value: WorkstreamCommitMutation): string {
  if (!MUTATION_TYPES.includes(value.type)) {
    invalid("Workstream commit mutation type is invalid.", { type: value.type });
  }
  const resourceId = identity(value.resourceId, "Mutation resource");
  const summary = boundedLine(value.summary, "Mutation summary", 500);
  return `${value.type} ${resourceId} — ${summary}`;
}

function parseMutation(value: string): WorkstreamCommitMutation {
  const match = /^([a-z_]+) (RES-[A-Za-z0-9]+) — (.+)$/.exec(value);
  if (!match) invalid("Workstream commit mutation metadata is invalid.");
  const mutation = {
    type: match[1] as WorkstreamCommitMutationType,
    resourceId: match[2] ?? "",
    summary: match[3] ?? "",
  };
  renderMutation(mutation);
  return mutation;
}

function problemCode(value: string): string {
  const normalized = requireSingleLine(value, "Problem-Code");
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(normalized)) {
    invalid("Workstream commit problem code is invalid.", { value });
  }
  return normalized;
}

function hash(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    invalid("Workstream commit message hash is invalid.");
  }
  return value;
}

function mutationCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("Workstream commit mutation count is invalid.");
  }
  return String(value);
}

function parseMutationCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    invalid("Workstream commit mutation count is invalid.");
  }
  return parsed;
}

function boundedLine(value: string, field: string, maximum: number): string {
  const normalized = requireSingleLine(value, field);
  if (normalized.length > maximum) {
    invalid("Workstream commit field exceeds its size limit.", { field, maximum });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new ContextEngineServiceError({
    code: "WORKSTREAM_REPOSITORY_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
