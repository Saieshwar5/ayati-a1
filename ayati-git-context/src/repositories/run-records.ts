import type { ContextDatabase } from "../database/database.js";
import type {
  RecordRunStepRequest,
  RunRef,
  StartRunRequest,
  ToolCallContext,
} from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import { bindConversationRun, readConversation } from "./conversation-records.js";

interface RunRow {
  run_id: string;
  session_id: string;
  conversation_id: string;
  task_id: string | null;
  run_class: RunRef["runClass"];
}

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
      details: {
        sessionId: input.sessionId,
        conversationId: input.conversationId,
      },
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
  database.prepare([
    "INSERT INTO runs(",
    "run_id, session_id, conversation_id, task_id, run_sequence, run_class,",
    "status, trigger, started_at, completed_at",
    ") VALUES (?, ?, ?, NULL, ?, 'session', 'running', ?, ?, NULL)",
  ].join(" ")).run(
    runId,
    input.sessionId,
    input.conversationId,
    sequence,
    input.trigger,
    input.at ?? new Date().toISOString(),
  );
  bindConversationRun(database, input.conversationId, runId);
  return {
    runId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    runClass: "session",
  };
}

export function readActiveRun(
  database: ContextDatabase,
  sessionId: string,
): RunRef | undefined {
  const row = database.prepare([
    "SELECT run_id, session_id, conversation_id, task_id, run_class",
    "FROM runs WHERE session_id = ? AND status = 'running' LIMIT 1",
  ].join(" ")).get(sessionId) as RunRow | undefined;
  return row ? runRef(row) : undefined;
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
  database.prepare([
    "UPDATE runs SET task_id = ?, run_class = 'task' WHERE run_id = ?",
  ].join(" ")).run(taskId, runId);
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
): ToolCallContext {
  const run = database.prepare([
    "SELECT run_id, session_id, status FROM runs WHERE run_id = ?",
  ].join(" ")).get(input.runId) as {
    run_id: string;
    session_id: string;
    status: string;
  } | undefined;
  if (!run || run.session_id !== input.sessionId || run.status !== "running") {
    throw new GitContextServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Run is not active in the requested session.",
      details: {
        sessionId: input.sessionId,
        runId: input.runId,
      },
    });
  }

  database.prepare([
    "INSERT INTO run_steps(",
    "run_id, step, tool, purpose, status, bounded_input, bounded_output,",
    "output_hash, verification, work_state, created_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    input.runId,
    input.step,
    input.tool,
    input.purpose,
    input.status,
    optionalJson(input.boundedInput),
    optionalJson(input.boundedOutput),
    input.outputHash ?? null,
    optionalJson(input.verification),
    optionalJson(input.workState),
    input.at,
  );
  return {
    step: input.step,
    tool: input.tool,
    purpose: input.purpose,
    status: input.status,
  };
}

export function readRecentRunSteps(
  database: ContextDatabase,
  runId: string,
  limit = 8,
): ToolCallContext[] {
  const rows = database.prepare([
    "SELECT step, tool, purpose, status FROM (",
    "  SELECT step, tool, purpose, status FROM run_steps",
    "  WHERE run_id = ? ORDER BY step DESC LIMIT ?",
    ") ORDER BY step",
  ].join(" ")).all(runId, limit) as unknown as Array<{
    step: number;
    tool: string;
    purpose: string;
    status: ToolCallContext["status"];
  }>;
  return rows.map((row) => ({
    step: Number(row.step),
    tool: row.tool,
    purpose: row.purpose,
    status: row.status,
  }));
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
