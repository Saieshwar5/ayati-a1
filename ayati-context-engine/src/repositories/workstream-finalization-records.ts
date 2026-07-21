import type {
  ResourceEvent,
  RunOutcome,
  RunStopReason,
  WorkstreamCompletionRecord,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

export type WorkstreamFinalizationPhase =
  | "prepared"
  | "resource_effects_recorded"
  | "context_committed"
  | "completed"
  | "recovery_required";

export interface WorkstreamContextWrite {
  path: string;
  content: string;
}

export interface WorkstreamContextCommitPlan {
  commitRequired: boolean;
  contextWrites: WorkstreamContextWrite[];
  contextBefore: Array<{ path: string; sha256: string }>;
  stagedPaths: string[];
  commitMessage: string;
}

export interface WorkstreamFinalizationRecord {
  runId: string;
  operationRequestId: string;
  leaseId?: string;
  streamId: string;
  workstreamId: string;
  boundRequestId: string;
  phase: WorkstreamFinalizationPhase;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  validation: "passed" | "failed" | "not_applicable";
  summary: string;
  next?: string;
  completion: WorkstreamCompletionRecord;
  assistantResponse: string;
  baseHead: string;
  messageHash: string;
  plan: WorkstreamContextCommitPlan;
  resourceEvents: ResourceEvent[];
  commitHead?: string;
  commitCreated: boolean;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

interface Row {
  run_id: string;
  operation_request_id: string;
  lease_id: string | null;
  stream_id: string;
  workstream_id: string;
  bound_request_id: string;
  phase: WorkstreamFinalizationPhase;
  outcome: RunOutcome;
  stop_reason: RunStopReason;
  validation: "passed" | "failed" | "not_applicable";
  summary: string;
  next_action: string | null;
  completion_json: string;
  assistant_response: string;
  base_head: string;
  message_hash: string;
  plan_json: string;
  resource_events_json: string;
  commit_head: string | null;
  commit_created: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export function insertWorkstreamFinalization(database: ContextDatabase, input: {
  runId: string;
  operationRequestId: string;
  leaseId?: string;
  streamId: string;
  workstreamId: string;
  boundRequestId: string;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  validation: "passed" | "failed" | "not_applicable";
  summary: string;
  next?: string;
  completion: WorkstreamCompletionRecord;
  assistantResponse: string;
  baseHead: string;
  messageHash: string;
  plan: WorkstreamContextCommitPlan;
  resourceEvents: ResourceEvent[];
  at: string;
}): WorkstreamFinalizationRecord {
  database.prepare([
    "INSERT INTO workstream_finalizations(",
    "run_id, operation_request_id, lease_id, stream_id, workstream_id, bound_request_id,",
    "phase, outcome, stop_reason, validation, summary, next_action, completion_json,",
    "assistant_response, base_head, message_hash, plan_json, resource_events_json, commit_head,",
    "commit_created, created_at, updated_at, last_error",
    ") VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, NULL)",
  ].join(" ")).run(
    input.runId,
    input.operationRequestId,
    input.leaseId ?? null,
    input.streamId,
    input.workstreamId,
    input.boundRequestId,
    input.outcome,
    input.stopReason,
    input.validation,
    input.summary,
    input.next ?? null,
    JSON.stringify(input.completion),
    input.assistantResponse,
    input.baseHead,
    input.messageHash,
    JSON.stringify(input.plan),
    JSON.stringify(input.resourceEvents),
    input.at,
    input.at,
  );
  return requireRecord(database, input.runId);
}

export function readWorkstreamFinalization(
  database: ContextDatabase,
  runId: string,
): WorkstreamFinalizationRecord | undefined {
  const row = database.prepare(select() + " WHERE run_id = ?").get(runId) as Row | undefined;
  return row ? record(row) : undefined;
}

export function readRecoverableWorkstreamFinalizations(
  database: ContextDatabase,
): WorkstreamFinalizationRecord[] {
  const rows = database.prepare([
    select(),
    "WHERE phase != 'completed' ORDER BY created_at, run_id",
  ].join(" ")).all() as unknown as Row[];
  return rows.map(record);
}

export function updateWorkstreamFinalization(database: ContextDatabase, input: {
  runId: string;
  phase: WorkstreamFinalizationPhase;
  at: string;
  commitHead?: string;
  commitCreated?: boolean;
  error?: string;
}): WorkstreamFinalizationRecord {
  database.prepare([
    "UPDATE workstream_finalizations SET phase = ?, updated_at = ?,",
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
): WorkstreamFinalizationRecord {
  const value = readWorkstreamFinalization(database, runId);
  if (!value) throw new Error("Workstream finalization record is missing: " + runId);
  return value;
}

function select(): string {
  return [
    "SELECT run_id, operation_request_id, lease_id, stream_id, workstream_id, bound_request_id,",
    "phase, outcome, stop_reason, validation, summary, next_action, completion_json,",
    "assistant_response, base_head, message_hash, plan_json, resource_events_json, commit_head,",
    "commit_created, created_at, updated_at, last_error FROM workstream_finalizations",
  ].join(" ");
}

function record(row: Row): WorkstreamFinalizationRecord {
  return {
    runId: row.run_id,
    operationRequestId: row.operation_request_id,
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    streamId: row.stream_id,
    workstreamId: row.workstream_id,
    boundRequestId: row.bound_request_id,
    phase: row.phase,
    outcome: row.outcome,
    stopReason: row.stop_reason,
    validation: row.validation,
    summary: row.summary,
    ...(row.next_action ? { next: row.next_action } : {}),
    completion: JSON.parse(row.completion_json) as WorkstreamCompletionRecord,
    assistantResponse: row.assistant_response,
    baseHead: row.base_head,
    messageHash: row.message_hash,
    plan: JSON.parse(row.plan_json) as WorkstreamContextCommitPlan,
    resourceEvents: JSON.parse(row.resource_events_json) as ResourceEvent[],
    ...(row.commit_head ? { commitHead: row.commit_head } : {}),
    commitCreated: Number(row.commit_created) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
