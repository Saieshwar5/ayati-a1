import type { ContextDatabase } from "../database/database.js";
import type {
  RecordRunStepRequest,
  RunContextRecord,
  RunOutcome,
  RunRef,
  RunStepContext,
  RunStopReason,
  RunWorkStateInput,
  TaskBinding,
  ToolEffect,
  ToolPurpose,
} from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import { bindConversationRun, readConversation } from "./conversation-records.js";
import {
  insertInitialRunWorkState,
  replaceRunWorkState,
} from "./run-work-state-records.js";

interface RunRow {
  run_id: string;
  session_id: string;
  conversation_id: string;
  task_id: string | null;
  task_request_id: string | null;
  task_bound_at: string | null;
}

interface RunEvidenceRow extends RunRow {
  status: RunContextRecord["status"];
  stop_reason: RunStopReason | null;
  trigger: RunContextRecord["trigger"];
  started_at: string;
  completed_at: string | null;
  step_count: number;
}

interface RunStepEvidenceRow {
  step: number;
  record_version: 1;
  status: RunStepContext["status"];
  summary: string;
  decision_json: string | null;
  action_json: string | null;
  tool_calls_json: string;
  verification_json: string;
  created_at: string;
}

const TOOL_PURPOSES = new Set<ToolPurpose>([
  "list",
  "read",
  "search",
  "control",
  "mutation",
]);

const TOOL_EFFECTS = new Set<ToolEffect>([
  "read_only",
  "workspace_mutation",
  "context_mutation",
  "external_mutation",
  "destructive",
]);

export interface RunEvidenceRecord extends RunContextRecord {}

export interface RunStepEvidenceRecord extends RunStepContext {}

export interface CreateRunInput {
  sessionId: string;
  conversationId: string;
  trigger: RunContextRecord["trigger"];
  workState: RunWorkStateInput;
  at: string;
}

export function createRun(database: ContextDatabase, input: CreateRunInput): RunRef {
  const active = readBlockingRun(database, input.sessionId);
  if (active) {
    throw new GitContextServiceError({
      code: "RUN_ALREADY_ACTIVE",
      message: "Session already has an active or recovery-required run.",
      details: { sessionId: input.sessionId, runId: active.runId },
    });
  }
  const conversation = readConversation(database, input.conversationId);
  if (!conversation || conversation.sessionId !== input.sessionId
    || conversation.status !== "active") {
    throw new GitContextServiceError({
      code: "CONVERSATION_NOT_ACTIVE",
      message: "Run conversation is not active in the requested session.",
      details: { sessionId: input.sessionId, conversationId: input.conversationId },
    });
  }

  const row = database.prepare([
    "SELECT COALESCE(MAX(run_sequence), 0) + 1 AS next",
    "FROM runs WHERE session_id = ?",
  ].join(" ")).get(input.sessionId) as { next: number };
  const sequence = Number(row.next);
  const datePart = input.sessionId.match(/^S-(\d{8})-/)?.[1] ?? "unknown";
  const runId = "R-" + datePart + "-" + String(sequence).padStart(4, "0");
  database.prepare([
    "INSERT INTO runs(",
    "run_id, session_id, conversation_id, task_id, task_request_id, task_bound_at,",
    "run_sequence, status, stop_reason, trigger, started_at, completed_at, step_count",
    ") VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'running', NULL, ?, ?, NULL, 0)",
  ].join(" ")).run(
    runId,
    input.sessionId,
    input.conversationId,
    sequence,
    input.trigger,
    input.at,
  );
  insertInitialRunWorkState(database, runId, input.workState, input.at);
  bindConversationRun(database, input.conversationId, runId);
  return {
    runId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
  };
}

export function readActiveRun(database: ContextDatabase, sessionId: string): RunRef | undefined {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, task_request_id, task_bound_at",
    "FROM runs WHERE session_id = ? AND status = 'running' LIMIT 1",
  ].join(" ")).get(sessionId) as RunRow | undefined;
  return row ? runRef(row) : undefined;
}

export function readBlockingRun(database: ContextDatabase, sessionId: string): RunRef | undefined {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, task_request_id, task_bound_at",
    "FROM runs WHERE session_id = ? AND status IN ('running', 'recovery_required') LIMIT 1",
  ].join(" ")).get(sessionId) as RunRow | undefined;
  return row ? runRef(row) : undefined;
}

export function readActiveRunIds(database: ContextDatabase): string[] {
  const rows = database.prepare([
    "SELECT run_id FROM runs WHERE status IN ('running', 'recovery_required') ORDER BY started_at",
  ].join(" ")).all() as unknown as Array<{ run_id: string }>;
  return rows.map((row) => row.run_id);
}

export function readRun(database: ContextDatabase, runId: string): RunRef | undefined {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, task_request_id, task_bound_at",
    "FROM runs WHERE run_id = ?",
  ].join(" ")).get(runId) as RunRow | undefined;
  return row ? runRef(row) : undefined;
}

export function readRunEvidence(
  database: ContextDatabase,
  runId: string,
): RunEvidenceRecord | undefined {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, task_request_id, task_bound_at,",
    "status, stop_reason, trigger, started_at, completed_at, step_count",
    "FROM runs WHERE run_id = ?",
  ].join(" ")).get(runId) as RunEvidenceRow | undefined;
  if (!row) return undefined;
  return {
    ...runRef(row),
    status: row.status,
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    trigger: row.trigger,
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    stepCount: Number(row.step_count),
  };
}

export function readRunStepEvidence(
  database: ContextDatabase,
  runId: string,
): RunStepEvidenceRecord[] {
  const rows = database.prepare([
    "SELECT step, record_version, status, summary, decision_json, action_json,",
    "tool_calls_json, verification_json, created_at",
    "FROM run_steps WHERE run_id = ? ORDER BY step",
  ].join(" ")).all(runId) as unknown as RunStepEvidenceRow[];
  return rows.map((row) => ({
    version: Number(row.record_version) as 1,
    step: Number(row.step),
    status: row.status,
    summary: row.summary,
    ...(row.decision_json ? { decision: JSON.parse(row.decision_json) as unknown } : {}),
    ...(row.action_json ? { action: JSON.parse(row.action_json) as unknown } : {}),
    toolCalls: JSON.parse(row.tool_calls_json) as RunStepContext["toolCalls"],
    verification: JSON.parse(row.verification_json) as unknown,
    createdAt: row.created_at,
  }));
}

export function finalizeRunRecord(database: ContextDatabase, input: {
  runId: string;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  at: string;
}): void {
  const result = database.prepare([
    "UPDATE runs SET status = ?, stop_reason = ?, completed_at = ?",
    "WHERE run_id = ? AND status IN ('running', 'recovery_required')",
  ].join(" ")).run(input.outcome, input.stopReason, input.at, input.runId);
  if (Number(result.changes) !== 1) {
    throw new GitContextServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Run could not be finalized from its current state.",
      details: { runId: input.runId },
    });
  }
}

export function markRunRecoveryRequired(
  database: ContextDatabase,
  runId: string,
): void {
  database.prepare([
    "UPDATE runs SET status = 'recovery_required', stop_reason = NULL, completed_at = NULL",
    "WHERE run_id = ? AND status = 'running'",
  ].join(" ")).run(runId);
}

export function bindActiveRunToTask(
  database: ContextDatabase,
  input: {
    sessionId: string;
    conversationId: string;
    runId: string;
    taskId: string;
    taskRequestId: string;
    at: string;
  },
): RunRef {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, task_request_id, task_bound_at",
    "FROM runs WHERE run_id = ? AND session_id = ? AND status = 'running'",
  ].join(" ")).get(input.runId, input.sessionId) as RunRow | undefined;
  if (!row || row.conversation_id !== input.conversationId) {
    throw new GitContextServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Task selection requires the matching active run and conversation.",
      details: {
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        runId: input.runId,
      },
    });
  }
  if (row.task_id || row.task_request_id || row.task_bound_at) {
    if (row.task_id === input.taskId && row.task_request_id === input.taskRequestId) {
      return runRef(row);
    }
    throw new GitContextServiceError({
      code: "RUN_TASK_BINDING_IMMUTABLE",
      message: "Run is already bound to a different task or request.",
      details: {
        runId: input.runId,
        activeTaskId: row.task_id,
        activeTaskRequestId: row.task_request_id,
        requestedTaskId: input.taskId,
        requestedTaskRequestId: input.taskRequestId,
      },
    });
  }

  database.prepare([
    "UPDATE runs SET task_id = ?, task_request_id = ?, task_bound_at = ? WHERE run_id = ?",
  ].join(" ")).run(input.taskId, input.taskRequestId, input.at, input.runId);
  database.prepare([
    "UPDATE conversation_segments SET task_id = ?, run_id = ? WHERE conversation_id = ?",
  ].join(" ")).run(input.taskId, input.runId, input.conversationId);
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    taskBinding: {
      taskId: input.taskId,
      taskRequestId: input.taskRequestId,
      boundAt: input.at,
    },
  };
}

export function recordRunStep(
  database: ContextDatabase,
  input: RecordRunStepRequest,
): { step: RunStepContext; workState: ReturnType<typeof replaceRunWorkState> } {
  const run = database.prepare([
    "SELECT session_id, task_id, task_request_id, status, step_count FROM runs WHERE run_id = ?",
  ].join(" ")).get(input.runId) as {
    session_id: string;
    task_id: string | null;
    task_request_id: string | null;
    status: string;
    step_count: number;
  } | undefined;
  if (!run || run.session_id !== input.sessionId || run.status !== "running") {
    throw new GitContextServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Run is not active in the requested session.",
      details: { sessionId: input.sessionId, runId: input.runId },
    });
  }
  const expectedStep = Number(run.step_count) + 1;
  if (input.record.step !== expectedStep) {
    throw new GitContextServiceError({
      code: "RUN_STEP_NOT_CONTIGUOUS",
      message: "Run steps must be recorded once in contiguous order.",
      details: { runId: input.runId, expectedStep, receivedStep: input.record.step },
    });
  }
  assertToolClassifications(input.record.toolCalls);
  const mutation = input.record.toolCalls.find((call) => call.toolPurpose === "mutation");
  if (mutation && (!run.task_id || !run.task_request_id)) {
    throw new GitContextServiceError({
      code: "MUTATION_REQUIRES_TASK_BINDING",
      message: "Mutation effects require an immutable task/request binding.",
      details: { runId: input.runId, tool: mutation.tool, toolEffect: mutation.toolEffect },
    });
  }

  database.prepare([
    "INSERT INTO run_steps(",
    "run_id, step, record_version, status, summary, decision_json, action_json,",
    "tool_calls_json, verification_json, created_at",
    ") VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    input.runId,
    input.record.step,
    input.record.status,
    input.record.summary,
    optionalJson(input.record.decision),
    optionalJson(input.record.action),
    JSON.stringify(input.record.toolCalls),
    JSON.stringify(input.record.verification),
    input.record.createdAt,
  );
  database.prepare("UPDATE runs SET step_count = step_count + 1 WHERE run_id = ?")
    .run(input.runId);
  const workState = replaceRunWorkState(database, {
    runId: input.runId,
    afterStep: input.record.step,
    state: input.record.workStateAfter,
    at: input.record.createdAt,
  });
  return { step: input.record, workState };
}

function runRef(row: RunRow): RunRef {
  const taskBinding = taskBindingFromRow(row);
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    ...(taskBinding ? { taskBinding } : {}),
  };
}

function taskBindingFromRow(row: RunRow): TaskBinding | undefined {
  if (!row.task_id || !row.task_request_id || !row.task_bound_at) return undefined;
  return {
    taskId: row.task_id,
    taskRequestId: row.task_request_id,
    boundAt: row.task_bound_at,
  };
}

function assertToolClassifications(
  calls: RunStepContext["toolCalls"],
): void {
  for (const call of calls) {
    if (!TOOL_PURPOSES.has(call.toolPurpose) || !TOOL_EFFECTS.has(call.toolEffect)) {
      throw new GitContextServiceError({
        code: "UNKNOWN_TOOL_CLASSIFICATION",
        message: "Run step contains an unknown tool purpose or effect.",
        details: {
          tool: call.tool,
          toolPurpose: call.toolPurpose,
          toolEffect: call.toolEffect,
        },
      });
    }
    const observational = call.toolPurpose === "list"
      || call.toolPurpose === "read"
      || call.toolPurpose === "search";
    const consistent = observational
      ? call.toolEffect === "read_only"
      : call.toolPurpose === "control"
        ? call.toolEffect === "context_mutation"
        : call.toolEffect !== "read_only";
    if (!consistent) {
      throw new GitContextServiceError({
        code: "UNKNOWN_TOOL_CLASSIFICATION",
        message: "Run step contains an inconsistent tool purpose and effect.",
        details: {
          tool: call.tool,
          toolPurpose: call.toolPurpose,
          toolEffect: call.toolEffect,
        },
      });
    }
  }
}

function optionalJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
