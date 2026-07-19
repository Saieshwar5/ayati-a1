import type {
  RunOutcome,
  RunStopReason,
  TaskCompletionRecord,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import type { SimpleTaskContextWrite } from "../tasks/simple-task-context-reducer.js";

export type SimpleTaskFinalizationPhase =
  | "prepared"
  | "committed"
  | "completed"
  | "recovery_required";

export interface SimpleTaskCommitPlan {
  commitRequired: boolean;
  verifiedPaths: string[];
  verifiedState: string;
  contextWrites: SimpleTaskContextWrite[];
  contextBefore: Array<{ path: string; sha256: string }>;
  stagedPaths: string[];
  commitMessage: string;
}

export interface SimpleTaskFinalizationRecord {
  runId: string;
  requestId: string;
  authorityId?: string;
  sessionId: string;
  taskId: string;
  taskRequestId: string;
  conversationId: string;
  phase: SimpleTaskFinalizationPhase;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  validation: "passed" | "failed" | "not_applicable";
  summary: string;
  next?: string;
  completion: TaskCompletionRecord;
  assistantResponse: string;
  baseHead: string;
  conversationHash: string;
  plan: SimpleTaskCommitPlan;
  commitHead?: string;
  commitCreated: boolean;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

interface Row {
  run_id: string;
  request_id: string;
  authority_id: string | null;
  session_id: string;
  task_id: string;
  task_request_id: string;
  conversation_id: string;
  phase: SimpleTaskFinalizationPhase;
  outcome: RunOutcome;
  stop_reason: RunStopReason;
  validation: "passed" | "failed" | "not_applicable";
  summary: string;
  next_action: string | null;
  completion_json: string;
  assistant_response: string;
  base_head: string;
  conversation_hash: string;
  plan_json: string;
  commit_head: string | null;
  commit_created: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export function insertSimpleTaskFinalization(database: ContextDatabase, input: {
  runId: string;
  requestId: string;
  authorityId?: string;
  sessionId: string;
  taskId: string;
  taskRequestId: string;
  conversationId: string;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  validation: "passed" | "failed" | "not_applicable";
  summary: string;
  next?: string;
  completion: TaskCompletionRecord;
  assistantResponse: string;
  baseHead: string;
  conversationHash: string;
  plan: SimpleTaskCommitPlan;
  at: string;
}): SimpleTaskFinalizationRecord {
  database.prepare([
    "INSERT INTO task_finalizations(",
    "run_id, request_id, authority_id, session_id, task_id, task_request_id,",
    "conversation_id, phase, outcome, stop_reason, validation, summary, next_action, completion_json,",
    "assistant_response, base_head, conversation_hash, plan_json, commit_head,",
    "commit_created, created_at, updated_at, last_error",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, NULL)",
  ].join(" ")).run(
    input.runId,
    input.requestId,
    input.authorityId ?? null,
    input.sessionId,
    input.taskId,
    input.taskRequestId,
    input.conversationId,
    input.outcome,
    input.stopReason,
    input.validation,
    input.summary,
    input.next ?? null,
    JSON.stringify(input.completion),
    input.assistantResponse,
    input.baseHead,
    input.conversationHash,
    JSON.stringify(input.plan),
    input.at,
    input.at,
  );
  return requireRecord(database, input.runId);
}

export function readSimpleTaskFinalization(
  database: ContextDatabase,
  runId: string,
): SimpleTaskFinalizationRecord | undefined {
  const row = database.prepare(select() + " WHERE run_id = ?").get(runId) as Row | undefined;
  return row ? record(row) : undefined;
}

export function readRecoverableSimpleTaskFinalizations(
  database: ContextDatabase,
): SimpleTaskFinalizationRecord[] {
  const rows = database.prepare([
    select(),
    "WHERE phase != 'completed' ORDER BY created_at, run_id",
  ].join(" ")).all() as unknown as Row[];
  return rows.map(record);
}

export function updateSimpleTaskFinalization(database: ContextDatabase, input: {
  runId: string;
  phase: SimpleTaskFinalizationPhase;
  at: string;
  commitHead?: string;
  commitCreated?: boolean;
  error?: string;
}): SimpleTaskFinalizationRecord {
  database.prepare([
    "UPDATE task_finalizations SET phase = ?, updated_at = ?,",
    "commit_head = COALESCE(?, commit_head),",
    "commit_created = COALESCE(?, commit_created), last_error = ? WHERE run_id = ?",
  ].join(" ")).run(
    input.phase,
    input.at,
    input.commitHead ?? null,
    input.commitCreated === undefined ? null : input.commitCreated ? 1 : 0,
    input.error ?? null,
    input.runId,
  );
  return requireRecord(database, input.runId);
}

function requireRecord(
  database: ContextDatabase,
  runId: string,
): SimpleTaskFinalizationRecord {
  const value = readSimpleTaskFinalization(database, runId);
  if (!value) throw new Error("V1 task finalization record is missing: " + runId);
  return value;
}

function select(): string {
  return [
    "SELECT run_id, request_id, authority_id, session_id, task_id, task_request_id,",
    "conversation_id, phase, outcome, stop_reason, validation, summary, next_action, completion_json,",
    "assistant_response, base_head, conversation_hash, plan_json, commit_head,",
    "commit_created, created_at, updated_at, last_error FROM task_finalizations",
  ].join(" ");
}

function record(row: Row): SimpleTaskFinalizationRecord {
  return {
    runId: row.run_id,
    requestId: row.request_id,
    ...(row.authority_id ? { authorityId: row.authority_id } : {}),
    sessionId: row.session_id,
    taskId: row.task_id,
    taskRequestId: row.task_request_id,
    conversationId: row.conversation_id,
    phase: row.phase,
    outcome: row.outcome,
    stopReason: row.stop_reason,
    validation: row.validation,
    summary: row.summary,
    ...(row.next_action ? { next: row.next_action } : {}),
    completion: JSON.parse(row.completion_json) as TaskCompletionRecord,
    assistantResponse: row.assistant_response,
    baseHead: row.base_head,
    conversationHash: row.conversation_hash,
    plan: JSON.parse(row.plan_json) as SimpleTaskCommitPlan,
    ...(row.commit_head ? { commitHead: row.commit_head } : {}),
    commitCreated: Number(row.commit_created) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
