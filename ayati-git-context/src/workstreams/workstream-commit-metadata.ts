import { GitContextServiceError } from "../errors.js";
import { requireRequestId, requireWorkstreamId } from "./workstream-repository-layout.js";
import { requireSingleLine } from "./workstream-markdown.js";

export type WorkstreamCommitOutcome = "completed" | "incomplete" | "blocked" | "failed";
export type WorkstreamCommitValidation = "passed" | "failed" | "not_applicable";

export interface WorkstreamIdentityCommitInput {
  subject: string;
  workstreamId: string;
  requestId: string;
}

export interface WorkstreamCommitInput extends WorkstreamIdentityCommitInput {
  runId: string;
  sessionId: string;
  outcome: WorkstreamCommitOutcome;
  validation: WorkstreamCommitValidation;
  summary: string;
  next?: string;
  conversationId?: string;
  conversationHash?: string;
}

export type WorkstreamCommitMetadata =
  | {
      event: "workstream_created";
      subject: string;
      workstreamId: string;
      requestId: string;
      outcome: "created";
      schema: "workstream/v2";
    }
  | {
      event: "workstream_bound_run_finalized";
      subject: string;
      workstreamId: string;
      requestId: string;
      runId: string;
      sessionId: string;
      outcome: WorkstreamCommitOutcome;
      validation: WorkstreamCommitValidation;
      summary: string;
      next?: string;
      conversationId?: string;
      conversationHash?: string;
      schema: "workstream/v2";
    };

export function renderWorkstreamIdentityCommit(input: WorkstreamIdentityCommitInput): string {
  return [
    subject(input.subject),
    "",
    "Workstream: " + requireWorkstreamId(input.workstreamId),
    "Request: " + requireRequestId(input.requestId),
    "Outcome: created",
    "Ayati-Schema: workstream/v2",
    "Ayati-Event: workstream_created",
  ].join("\n");
}

export function renderWorkstreamCommit(input: WorkstreamCommitInput): string {
  const lines = [
    subject(input.subject),
    "",
    "Workstream: " + requireWorkstreamId(input.workstreamId),
    "Request: " + requireRequestId(input.requestId),
    "Run: " + identity(input.runId, "Run"),
    "Session: " + identity(input.sessionId, "Session"),
    "Outcome: " + outcome(input.outcome),
    "Validation: " + validation(input.validation),
    "Summary: " + boundedLine(input.summary, "Summary", 1_000),
    ...(input.next ? ["Next: " + boundedLine(input.next, "Next", 500)] : []),
    ...(input.conversationId
      ? ["Conversation-Id: " + identity(input.conversationId, "Conversation-Id")]
      : []),
    ...(input.conversationHash
      ? ["Conversation-Hash: " + hash(input.conversationHash)]
      : []),
    "Ayati-Schema: workstream/v2",
    "Ayati-Event: workstream_bound_run_finalized",
  ];
  return lines.join("\n");
}

export function parseWorkstreamCommit(message: string): WorkstreamCommitMetadata | undefined {
  const lines = message.replaceAll("\r\n", "\n").trim().split("\n");
  const commitSubject = lines[0]?.trim();
  if (!commitSubject) return undefined;
  const fields = parseFields(lines.slice(1));
  const event = fields["Ayati-Event"];
  if (!event) return undefined;
  if (fields["Ayati-Schema"] !== "workstream/v2") {
    invalid("Workstream commit contains an unsupported Ayati schema.", {
      schema: fields["Ayati-Schema"] ?? null,
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
      schema: "workstream/v2",
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
    sessionId: identity(required(fields, "Session"), "Session"),
    outcome: outcome(required(fields, "Outcome")),
    validation: validation(required(fields, "Validation")),
    summary: boundedLine(required(fields, "Summary"), "Summary", 1_000),
    ...(fields["Next"] ? { next: boundedLine(fields["Next"], "Next", 500) } : {}),
    ...(fields["Conversation-Id"]
      ? { conversationId: identity(fields["Conversation-Id"], "Conversation-Id") }
      : {}),
    ...(fields["Conversation-Hash"]
      ? { conversationHash: hash(fields["Conversation-Hash"]) }
      : {}),
    schema: "workstream/v2",
  };
  return parsed;
}

function parseFields(lines: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z][A-Za-z-]*):\s*(.+)$/);
    if (!match?.[1] || !match[2]) {
      invalid("Workstream commit contains an invalid metadata line.");
    }
    if (result[match[1]] !== undefined) {
      invalid("Workstream commit contains duplicate metadata.", { field: match[1] });
    }
    result[match[1]] = match[2].trim();
  }
  return result;
}

const IDENTITY_FIELDS = new Set([
  "Workstream",
  "Request",
  "Outcome",
  "Ayati-Schema",
  "Ayati-Event",
]);

const FINALIZATION_FIELDS = new Set([
  ...IDENTITY_FIELDS,
  "Run",
  "Session",
  "Validation",
  "Summary",
  "Next",
  "Conversation-Id",
  "Conversation-Hash",
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
  if (value === "passed" || value === "failed" || value === "not_applicable") {
    return value;
  }
  invalid("Workstream-bound run commit validation is invalid.", { value });
}

function hash(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    invalid("Workstream commit conversation hash is invalid.");
  }
  return value;
}

function boundedLine(value: string, field: string, maximum: number): string {
  const normalized = requireSingleLine(value, field);
  if (normalized.length > maximum) {
    invalid("Workstream commit field exceeds its size limit.", { field, maximum });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new GitContextServiceError({
    code: "WORKSTREAM_REPOSITORY_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
