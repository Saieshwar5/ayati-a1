import { GitContextServiceError } from "../errors.js";
import { requireRequestId, requireTaskId } from "./task-repository-layout.js";
import { requireSingleLine } from "./task-markdown.js";

export type TaskRunCommitOutcome = "completed" | "incomplete" | "blocked" | "failed";
export type TaskRunCommitValidation = "passed" | "failed" | "not_run";

export interface TaskIdentityCommitInput {
  subject: string;
  taskId: string;
  requestId: string;
}

export interface TaskRunCommitInput extends TaskIdentityCommitInput {
  runId: string;
  sessionId: string;
  outcome: TaskRunCommitOutcome;
  validation: TaskRunCommitValidation;
  next?: string;
  conversationId?: string;
  conversationHash?: string;
}

export type SimpleTaskCommitMetadata =
  | {
      event: "task_created";
      subject: string;
      taskId: string;
      requestId: string;
      outcome: "created";
      schema: "task/v1";
    }
  | {
      event: "task_run_finalized";
      subject: string;
      taskId: string;
      requestId: string;
      runId: string;
      sessionId: string;
      outcome: TaskRunCommitOutcome;
      validation: TaskRunCommitValidation;
      next?: string;
      conversationId?: string;
      conversationHash?: string;
      schema: "task/v1";
    };

export function renderTaskIdentityCommit(input: TaskIdentityCommitInput): string {
  return [
    subject(input.subject),
    "",
    "Task: " + requireTaskId(input.taskId),
    "Request: " + requireRequestId(input.requestId),
    "Outcome: created",
    "Ayati-Schema: task/v1",
    "Ayati-Event: task_created",
  ].join("\n");
}

export function renderTaskRunCommit(input: TaskRunCommitInput): string {
  const lines = [
    subject(input.subject),
    "",
    "Task: " + requireTaskId(input.taskId),
    "Request: " + requireRequestId(input.requestId),
    "Run: " + identity(input.runId, "Run"),
    "Session: " + identity(input.sessionId, "Session"),
    "Outcome: " + outcome(input.outcome),
    "Validation: " + validation(input.validation),
    ...(input.next ? ["Next: " + boundedLine(input.next, "Next", 500)] : []),
    ...(input.conversationId
      ? ["Conversation-Id: " + identity(input.conversationId, "Conversation-Id")]
      : []),
    ...(input.conversationHash
      ? ["Conversation-Hash: " + hash(input.conversationHash)]
      : []),
    "Ayati-Schema: task/v1",
    "Ayati-Event: task_run_finalized",
  ];
  return lines.join("\n");
}

export function parseSimpleTaskCommit(message: string): SimpleTaskCommitMetadata | undefined {
  const lines = message.replaceAll("\r\n", "\n").trim().split("\n");
  const commitSubject = lines[0]?.trim();
  if (!commitSubject) return undefined;
  const fields = parseFields(lines.slice(1));
  const event = fields["Ayati-Event"];
  if (!event) return undefined;
  if (fields["Ayati-Schema"] !== "task/v1") {
    invalid("Task commit contains an unsupported Ayati schema.", {
      schema: fields["Ayati-Schema"] ?? null,
    });
  }
  const taskId = requireTaskId(required(fields, "Task"));
  const requestId = requireRequestId(required(fields, "Request"));
  if (event === "task_created") {
    rejectUnsupportedFields(fields, IDENTITY_FIELDS);
    if (fields["Outcome"] !== "created") {
      invalid("Task identity commit outcome does not match its event.", { event });
    }
    return {
      event,
      subject: commitSubject,
      taskId,
      requestId,
      outcome: "created",
      schema: "task/v1",
    };
  }
  if (event !== "task_run_finalized") {
    invalid("Task commit contains an unsupported Ayati event.", { event });
  }
  rejectUnsupportedFields(fields, FINALIZATION_FIELDS);
  const parsed: SimpleTaskCommitMetadata = {
    event,
    subject: commitSubject,
    taskId,
    requestId,
    runId: identity(required(fields, "Run"), "Run"),
    sessionId: identity(required(fields, "Session"), "Session"),
    outcome: outcome(required(fields, "Outcome")),
    validation: validation(required(fields, "Validation")),
    ...(fields["Next"] ? { next: boundedLine(fields["Next"], "Next", 500) } : {}),
    ...(fields["Conversation-Id"]
      ? { conversationId: identity(fields["Conversation-Id"], "Conversation-Id") }
      : {}),
    ...(fields["Conversation-Hash"]
      ? { conversationHash: hash(fields["Conversation-Hash"]) }
      : {}),
    schema: "task/v1",
  };
  return parsed;
}

function parseFields(lines: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z][A-Za-z-]*):\s*(.+)$/);
    if (!match?.[1] || !match[2]) {
      invalid("Task commit contains an invalid metadata line.");
    }
    if (result[match[1]] !== undefined) {
      invalid("Task commit contains duplicate metadata.", { field: match[1] });
    }
    result[match[1]] = match[2].trim();
  }
  return result;
}

const IDENTITY_FIELDS = new Set([
  "Task",
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
    invalid("Task commit contains unsupported metadata.", { unsupportedFields: unsupported });
  }
}

function required(fields: Record<string, string>, field: string): string {
  const value = fields[field];
  if (!value) invalid("Task commit is missing required metadata.", { field });
  return value;
}

function subject(value: string): string {
  const normalized = requireSingleLine(value, "commit subject")
    .replace(/[.!?]+$/, "")
    .toLowerCase();
  if (normalized.length > 72) {
    invalid("Task commit subject may contain at most 72 characters.");
  }
  return normalized;
}

function identity(value: string, field: string): string {
  const normalized = requireSingleLine(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(normalized)) {
    invalid("Task commit identity field is invalid.", { field });
  }
  return normalized;
}

function outcome(value: string): TaskRunCommitOutcome {
  if (value === "completed" || value === "incomplete" || value === "blocked"
    || value === "failed") {
    return value;
  }
  invalid("Task run commit outcome is invalid.", { value });
}

function validation(value: string): TaskRunCommitValidation {
  if (value === "passed" || value === "failed" || value === "not_run") {
    return value;
  }
  invalid("Task run commit validation is invalid.", { value });
}

function hash(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    invalid("Task commit conversation hash is invalid.");
  }
  return value;
}

function boundedLine(value: string, field: string, maximum: number): string {
  const normalized = requireSingleLine(value, field);
  if (normalized.length > maximum) {
    invalid("Task commit field exceeds its size limit.", { field, maximum });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new GitContextServiceError({
    code: "TASK_REPOSITORY_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
