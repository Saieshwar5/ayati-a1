import type { TaskCompletionRecord, TaskRunOutcome } from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

export type TaskRunFinalizationPhase =
  | "prepared"
  | "conversation_closed"
  | "task_finalized"
  | "task_persisted"
  | "session_staged"
  | "session_committed"
  | "completed";

interface FinalizationRow {
  run_id: string;
  request_id: string;
  session_id: string;
  task_id: string;
  conversation_id: string;
  phase: TaskRunFinalizationPhase;
  outcome: TaskRunOutcome;
  conversation_summary: string | null;
  summary: string;
  validation: "passed" | "failed" | "not_run";
  next_action: string | null;
  completion_json: string | null;
  assistant_response: string;
  session_head_before: string;
  task_head_before: string;
  task_checkpoint_head: string;
  conversation_hash: string | null;
  task_finalization_head: string | null;
  session_commit: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRunFinalizationRecord {
  runId: string;
  requestId: string;
  sessionId: string;
  taskId: string;
  conversationId: string;
  phase: TaskRunFinalizationPhase;
  outcome: TaskRunOutcome;
  conversationSummary: string;
  summary: string;
  validation: "passed" | "failed" | "not_run";
  next?: string;
  completion: TaskCompletionRecord;
  assistantResponse: string;
  sessionHeadBefore: string;
  taskHeadBefore: string;
  taskCheckpointHead: string;
  conversationHash?: string;
  taskFinalizationHead?: string;
  sessionCommit?: string;
  createdAt: string;
  updatedAt: string;
}

export function insertTaskRunFinalization(database: ContextDatabase, input: {
  runId: string;
  requestId: string;
  sessionId: string;
  taskId: string;
  conversationId: string;
  outcome: TaskRunOutcome;
  conversationSummary: string;
  summary: string;
  validation: "passed" | "failed" | "not_run";
  next?: string;
  completion: TaskCompletionRecord;
  assistantResponse: string;
  sessionHeadBefore: string;
  taskHeadBefore: string;
  taskCheckpointHead: string;
  at: string;
}): TaskRunFinalizationRecord {
  database.prepare([
    "INSERT INTO task_run_finalizations(",
    "run_id, request_id, session_id, task_id, conversation_id, phase, outcome, summary,",
    "validation, next_action, completion_json, assistant_response, session_head_before,",
    "task_head_before, task_checkpoint_head, conversation_hash, task_finalization_head,",
    "session_commit, created_at, updated_at, conversation_summary",
    ") VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)",
  ].join(" ")).run(
    input.runId, input.requestId, input.sessionId, input.taskId, input.conversationId,
    input.outcome, input.summary, input.validation, input.next ?? null,
    JSON.stringify(input.completion),
    input.assistantResponse, input.sessionHeadBefore, input.taskHeadBefore,
    input.taskCheckpointHead, input.at, input.at, input.conversationSummary,
  );
  return requireFinalization(database, input.runId);
}

export function readTaskRunFinalization(
  database: ContextDatabase,
  runId: string,
): TaskRunFinalizationRecord | undefined {
  const row = database.prepare(finalizationSelect() + " WHERE run_id = ?")
    .get(runId) as FinalizationRow | undefined;
  return row ? finalizationRecord(row) : undefined;
}

export function updateTaskRunFinalization(database: ContextDatabase, input: {
  runId: string;
  phase: TaskRunFinalizationPhase;
  at: string;
  conversationHash?: string;
  taskFinalizationHead?: string;
  sessionCommit?: string;
}): TaskRunFinalizationRecord {
  database.prepare([
    "UPDATE task_run_finalizations SET phase = ?, updated_at = ?,",
    "conversation_hash = COALESCE(?, conversation_hash),",
    "task_finalization_head = COALESCE(?, task_finalization_head),",
    "session_commit = COALESCE(?, session_commit) WHERE run_id = ?",
  ].join(" ")).run(
    input.phase, input.at, input.conversationHash ?? null,
    input.taskFinalizationHead ?? null, input.sessionCommit ?? null, input.runId,
  );
  return requireFinalization(database, input.runId);
}

function requireFinalization(database: ContextDatabase, runId: string): TaskRunFinalizationRecord {
  const record = readTaskRunFinalization(database, runId);
  if (!record) throw new Error("Task-run finalization could not be read: " + runId);
  return record;
}

function finalizationSelect(): string {
  return [
    "SELECT run_id, request_id, session_id, task_id, conversation_id, phase, outcome,",
    "summary, validation, next_action, completion_json, assistant_response,",
    "session_head_before, task_head_before, task_checkpoint_head, conversation_hash,",
    "task_finalization_head, session_commit, created_at, updated_at, conversation_summary",
    "FROM task_run_finalizations",
  ].join(" ");
}

function finalizationRecord(row: FinalizationRow): TaskRunFinalizationRecord {
  return {
    runId: row.run_id, requestId: row.request_id, sessionId: row.session_id,
    taskId: row.task_id, conversationId: row.conversation_id, phase: row.phase,
    outcome: row.outcome,
    conversationSummary: row.conversation_summary ?? row.summary,
    summary: row.summary,
    validation: row.validation,
    ...(row.next_action ? { next: row.next_action } : {}),
    completion: parseCompletion(row),
    assistantResponse: row.assistant_response, sessionHeadBefore: row.session_head_before,
    taskHeadBefore: row.task_head_before, taskCheckpointHead: row.task_checkpoint_head,
    ...(row.conversation_hash ? { conversationHash: row.conversation_hash } : {}),
    ...(row.task_finalization_head ? { taskFinalizationHead: row.task_finalization_head } : {}),
    ...(row.session_commit ? { sessionCommit: row.session_commit } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function parseCompletion(row: FinalizationRow): TaskCompletionRecord {
  if (!row.completion_json) {
    throw new Error("Task-run finalization is missing deterministic completion evidence.");
  }
  return JSON.parse(row.completion_json) as TaskCompletionRecord;
}
