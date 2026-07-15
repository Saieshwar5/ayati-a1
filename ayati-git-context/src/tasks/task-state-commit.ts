import type { TaskRunOutcome } from "../contracts.js";

export const TASK_STATE_VERSION = 1;

export type PersistentTaskStatus = "in_progress" | "done" | "blocked";

export interface TaskStateCommit {
  version: number;
  taskId: string;
  title: string;
  status: PersistentTaskStatus;
  state: string;
  validation: "passed" | "failed" | "not_run";
  next: string | null;
  runId: string;
  sessionId: string;
  conversationId: string;
  conversationHash: string;
  runOutcome: TaskRunOutcome;
}

export function renderTaskStateCommit(input: TaskStateCommit): string {
  return [
    "task: " + subject(input.state),
    "",
    "Task-State: " + singleLine(input.state),
    "Task-Id: " + input.taskId,
    "Task-Title: " + singleLine(input.title),
    "Task-Status: " + input.status,
    "Validation: " + input.validation,
    "Next: " + (input.next ? singleLine(input.next) : "none"),
    "Run: " + input.runId,
    "Session: " + input.sessionId,
    "Conversation-Id: " + input.conversationId,
    "Conversation-Hash: " + input.conversationHash,
    "Run-Outcome: " + input.runOutcome,
    "Ayati-State-Version: " + String(input.version),
    "Ayati-Event: task_run_committed",
  ].join("\n");
}

export function parseTaskStateCommit(message: string): TaskStateCommit | undefined {
  const fields = parseFields(message);
  const version = Number(fields["Ayati-State-Version"]);
  const status = persistentTaskStatus(fields["Task-Status"]);
  const validation = validationStatus(fields["Validation"]);
  const outcome = runOutcome(fields["Run-Outcome"]);
  const state = fields["Task-State"];
  const taskId = fields["Task-Id"];
  const title = fields["Task-Title"];
  const runId = fields["Run"];
  const sessionId = fields["Session"];
  const conversationId = fields["Conversation-Id"];
  const conversationHash = fields["Conversation-Hash"];
  if (version !== TASK_STATE_VERSION || !status || !validation || !outcome
    || !state || !taskId || !title || !runId || !sessionId
    || !conversationId || !conversationHash) {
    return undefined;
  }
  return {
    version,
    taskId,
    title,
    status,
    state,
    validation,
    next: fields["Next"] && fields["Next"] !== "none" ? fields["Next"] : null,
    runId,
    sessionId,
    conversationId,
    conversationHash,
    runOutcome: outcome,
  };
}

export function persistentTaskStatusForOutcome(outcome: TaskRunOutcome): PersistentTaskStatus {
  if (outcome === "done") return "done";
  if (outcome === "blocked" || outcome === "needs_user_input") return "blocked";
  return "in_progress";
}

function parseFields(message: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z-]*):\s*(.+)$/);
    if (match?.[1] && match[2]) result[match[1]] = match[2].trim();
  }
  return result;
}

function persistentTaskStatus(value: string | undefined): PersistentTaskStatus | undefined {
  return value === "in_progress" || value === "done" || value === "blocked"
    ? value
    : undefined;
}

function validationStatus(value: string | undefined): TaskStateCommit["validation"] | undefined {
  return value === "passed" || value === "failed" || value === "not_run"
    ? value
    : undefined;
}

function runOutcome(value: string | undefined): TaskRunOutcome | undefined {
  return value === "done" || value === "incomplete" || value === "failed"
    || value === "blocked" || value === "needs_user_input"
    ? value
    : undefined;
}

function subject(value: string): string {
  return singleLine(value).replace(/[.!?]+$/, "").slice(0, 72).toLowerCase();
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
