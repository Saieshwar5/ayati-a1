import type { ContextDatabase } from "../database/database.js";
import type {
  RecordRunStepRequest,
  RunContextRecord,
  RunRef,
  RunStepContext,
  StartRunRequest,
  TaskRunOutcome,
  ToolCallContext,
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
  run_class: RunRef["runClass"];
}

interface RunEvidenceRow extends RunRow {
  status: RunContextRecord["status"];
  trigger: RunContextRecord["trigger"];
  started_at: string;
  completed_at: string | null;
  step_count: number;
}

interface RunStepEvidenceRow {
  step: number;
  tool: string;
  tool_schema_version: number;
  tool_effect: ToolCallContext["toolEffect"];
  purpose: string;
  status: ToolCallContext["status"];
  input_json: string | null;
  output_json: string | null;
  output_hash: string | null;
  verification_json: string | null;
  created_at: string;
}

export interface RunEvidenceRecord extends RunContextRecord {}

export interface RunStepEvidenceRecord extends RunStepContext {}

export function startSessionRun(database: ContextDatabase, input: StartRunRequest): RunRef {
  const active = readActiveRun(database, input.sessionId);
  if (active) {
    throw new GitContextServiceError({
      code: "RUN_ALREADY_ACTIVE",
      message: "Session already has an active run.",
      details: { sessionId: input.sessionId, runId: active.runId },
    });
  }
  const conversation = readConversation(database, input.conversationId);
  if (!conversation || conversation.sessionId !== input.sessionId) {
    throw new GitContextServiceError({
      code: "CONVERSATION_NOT_ACTIVE",
      message: "Run conversation does not exist in the requested session.",
      details: { sessionId: input.sessionId, conversationId: input.conversationId },
    });
  }
  if (conversation.status !== "active") {
    throw new GitContextServiceError({
      code: "CONVERSATION_NOT_ACTIVE",
      message: "Run conversation is not active.",
      details: { conversationId: input.conversationId },
    });
  }

  const row = database.prepare([
    "SELECT COALESCE(MAX(run_sequence), 0) + 1 AS next",
    "FROM runs WHERE session_id = ?",
  ].join(" ")).get(input.sessionId) as { next: number };
  const sequence = Number(row.next);
  const datePart = input.sessionId.match(/^S-(\d{8})-/)?.[1] ?? "unknown";
  const runId = "R-" + datePart + "-" + String(sequence).padStart(4, "0");
  const startedAt = input.at ?? new Date().toISOString();
  database.prepare([
    "INSERT INTO runs(",
    "run_id, session_id, conversation_id, task_id, run_sequence, run_class,",
    "status, trigger, started_at, completed_at, step_count",
    ") VALUES (?, ?, ?, NULL, ?, 'session', 'running', ?, ?, NULL, 0)",
  ].join(" ")).run(
    runId,
    input.sessionId,
    input.conversationId,
    sequence,
    input.trigger,
    startedAt,
  );
  insertInitialRunWorkState(database, runId, input.workState, startedAt);
  bindConversationRun(database, input.conversationId, runId);
  return {
    runId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    runClass: "session",
  };
}

export function startTaskRun(
  database: ContextDatabase,
  input: StartRunRequest,
  taskId: string,
): RunRef {
  const run = startSessionRun(database, input);
  return bindActiveRunToTask(database, input.sessionId, run.runId, taskId);
}

export function readActiveRun(database: ContextDatabase, sessionId: string): RunRef | undefined {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, run_class",
    "FROM runs WHERE session_id = ? AND status = 'running' LIMIT 1",
  ].join(" ")).get(sessionId) as RunRow | undefined;
  return row ? runRef(row) : undefined;
}

export function readActiveRunIds(database: ContextDatabase): string[] {
  const rows = database.prepare([
    "SELECT run_id FROM runs WHERE status = 'running' ORDER BY started_at",
  ].join(" ")).all() as unknown as Array<{ run_id: string }>;
  return rows.map((row) => row.run_id);
}

export function readRun(database: ContextDatabase, runId: string): RunRef | undefined {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, run_class",
    "FROM runs WHERE run_id = ?",
  ].join(" ")).get(runId) as RunRow | undefined;
  return row ? runRef(row) : undefined;
}

export function readRunEvidence(
  database: ContextDatabase,
  runId: string,
): RunEvidenceRecord | undefined {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, run_class, status, trigger,",
    "started_at, completed_at, step_count FROM runs WHERE run_id = ?",
  ].join(" ")).get(runId) as RunEvidenceRow | undefined;
  if (!row) return undefined;
  return {
    ...runRef(row),
    status: row.status,
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
    "SELECT step, tool, tool_schema_version, tool_effect, purpose, status, input_json, output_json,",
    "output_hash, verification_json, created_at FROM run_steps WHERE run_id = ? ORDER BY step",
  ].join(" ")).all(runId) as unknown as RunStepEvidenceRow[];
  return rows.map((row) => ({
    step: Number(row.step),
    tool: row.tool,
    toolSchemaVersion: Number(row.tool_schema_version),
    toolEffect: row.tool_effect,
    purpose: row.purpose,
    status: row.status,
    ...(row.input_json ? { input: JSON.parse(row.input_json) as unknown } : {}),
    ...(row.output_json ? { output: JSON.parse(row.output_json) as unknown } : {}),
    ...(row.output_hash ? { outputHash: row.output_hash } : {}),
    ...(row.verification_json
      ? { verification: JSON.parse(row.verification_json) as unknown }
      : {}),
    createdAt: row.created_at,
  }));
}

export function completeSessionRun(database: ContextDatabase, runId: string, at: string): void {
  const result = database.prepare([
    "UPDATE runs SET status = 'completed', completed_at = ?",
    "WHERE run_id = ? AND run_class = 'session' AND status = 'running'",
  ].join(" ")).run(at, runId);
  if (Number(result.changes) !== 1) {
    throw new Error("Running session run could not be completed: " + runId);
  }
}

export function completeTaskRun(database: ContextDatabase, input: {
  runId: string;
  outcome: TaskRunOutcome;
  at: string;
}): void {
  const status = input.outcome === "failed"
    ? "failed"
    : input.outcome === "blocked"
      ? "blocked"
      : input.outcome === "needs_user_input"
        ? "needs_user_input"
        : "completed";
  const result = database.prepare([
    "UPDATE runs SET status = ?, completed_at = ?",
    "WHERE run_id = ? AND run_class = 'task' AND status = 'running'",
  ].join(" ")).run(status, input.at, input.runId);
  if (Number(result.changes) !== 1) {
    throw new Error("Running task run could not be completed: " + input.runId);
  }
}

export function bindActiveRunToTask(
  database: ContextDatabase,
  sessionId: string,
  runId: string,
  taskId: string,
): RunRef {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, run_class",
    "FROM runs WHERE run_id = ? AND session_id = ? AND status = 'running'",
  ].join(" ")).get(runId, sessionId) as RunRow | undefined;
  if (!row) {
    throw new GitContextServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Mutation authority requires an active run in the requested session.",
      details: { sessionId, runId },
    });
  }
  if (row.task_id && row.task_id !== taskId) {
    throw new GitContextServiceError({
      code: "MUTATION_REQUIRES_TASK",
      message: "Active run is already owned by a different task.",
      details: { sessionId, runId, activeTaskId: row.task_id, requestedTaskId: taskId },
    });
  }
  database.prepare("UPDATE runs SET task_id = ?, run_class = 'task' WHERE run_id = ?")
    .run(taskId, runId);
  database.prepare([
    "UPDATE conversation_segments SET task_id = ?, run_id = ? WHERE conversation_id = ?",
  ].join(" ")).run(taskId, runId, row.conversation_id);
  return {
    runId,
    sessionId,
    conversationId: row.conversation_id,
    runClass: "task",
    taskId,
  };
}

export function recordRunStep(
  database: ContextDatabase,
  input: RecordRunStepRequest,
): RecordRunStepResponseValue {
  const run = database.prepare([
    "SELECT run_id, session_id, run_class, status FROM runs WHERE run_id = ?",
  ].join(" ")).get(input.runId) as {
    run_id: string;
    session_id: string;
    run_class: RunRef["runClass"];
    status: string;
  } | undefined;
  if (!run || run.session_id !== input.sessionId || run.status !== "running") {
    throw new GitContextServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Run is not active in the requested session.",
      details: { sessionId: input.sessionId, runId: input.runId },
    });
  }
  if (run.run_class === "session" && input.toolEffect !== "read_only") {
    throw new GitContextServiceError({
      code: "MUTATION_REQUIRES_TASK",
      message: "Session runs may record only read-only tools.",
      details: { runId: input.runId, tool: input.tool },
    });
  }

  database.prepare([
    "INSERT INTO run_steps(",
    "run_id, step, tool, tool_schema_version, tool_effect, purpose, status, input_json, output_json,",
    "output_hash, verification_json, created_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    input.runId,
    input.step,
    input.tool,
    input.toolSchemaVersion ?? 1,
    input.toolEffect,
    input.purpose,
    input.status,
    optionalJson(input.input),
    optionalJson(input.output),
    input.outputHash ?? null,
    optionalJson(input.verification),
    input.at,
  );
  database.prepare("UPDATE runs SET step_count = step_count + 1 WHERE run_id = ?")
    .run(input.runId);
  const workState = replaceRunWorkState(database, {
    runId: input.runId,
    afterStep: input.step,
    state: input.workState,
    at: input.at,
  });
  return {
    toolCall: {
      step: input.step,
      tool: input.tool,
      toolSchemaVersion: input.toolSchemaVersion ?? 1,
      toolEffect: input.toolEffect,
      purpose: input.purpose,
      status: input.status,
    },
    workState,
  };
}

interface RecordRunStepResponseValue {
  toolCall: ToolCallContext;
  workState: ReturnType<typeof replaceRunWorkState>;
}

function runRef(row: RunRow): RunRef {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    runClass: row.run_class,
    ...(row.task_id ? { taskId: row.task_id } : {}),
  };
}

function optionalJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
