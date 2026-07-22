import { createHash } from "node:crypto";
import type {
  StartWorkstreamResolutionRequest,
  WorkstreamResolutionActivity,
  WorkstreamResolutionProjection,
  WorkstreamResolutionResult,
  WorkstreamResolutionStepRecord,
  WorkstreamResolutionUsage,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";

interface ActivityRow {
  activity_id: string;
  run_id: string;
  stream_id: string;
  prior_activity_id: string | null;
  status: WorkstreamResolutionActivity["status"];
  input_json: string;
  input_context_revision: string;
  output_context_revision: string | null;
  step_count: number;
  tool_call_count: number;
  usage_json: string;
  final_state_json: string | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  error_retryable: number | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface StepRow {
  step: number;
  record_version: 1;
  status: WorkstreamResolutionStepRecord["status"];
  context_json: string;
  decision_json: string;
  tool_calls_json: string;
  verification_json: string;
  state_after_json: string;
  usage_json: string | null;
  created_at: string;
}

const EMPTY_USAGE: WorkstreamResolutionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export function insertWorkstreamResolutionActivity(
  database: ContextDatabase,
  input: StartWorkstreamResolutionRequest,
): WorkstreamResolutionActivity {
  const existing = readWorkstreamResolutionByRun(database, input.runId);
  if (existing) {
    const matches = existing.streamId === input.streamId
      && existing.inputContextRevision === input.inputContextRevision
      && existing.priorActivityId === input.priorActivityId
      && JSON.stringify(existing.input) === JSON.stringify(input.input);
    if (!matches) {
      throw invalid("Run already owns a different workstream resolution activity.", {
        runId: input.runId,
        activityId: existing.activityId,
      });
    }
    return existing;
  }
  const activityId = activityIdForRun(input.runId);
  database.prepare([
    "INSERT INTO workstream_resolution_activities(",
    "activity_id, run_id, stream_id, prior_activity_id, status, input_json,",
    "input_context_revision, output_context_revision, step_count, tool_call_count,",
    "usage_json, final_state_json, result_json, error_code, error_message,",
    "error_retryable, started_at, updated_at, completed_at",
    ") VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, 0, 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)",
  ].join(" ")).run(
    activityId,
    input.runId,
    input.streamId,
    input.priorActivityId ?? null,
    JSON.stringify(input.input),
    input.inputContextRevision,
    JSON.stringify(EMPTY_USAGE),
    input.at,
    input.at,
  );
  return requireWorkstreamResolutionActivity(database, activityId);
}

export function readWorkstreamResolutionActivity(
  database: ContextDatabase,
  activityId: string,
): WorkstreamResolutionActivity | undefined {
  const row = database.prepare([
    "SELECT activity_id, run_id, stream_id, prior_activity_id, status, input_json,",
    "input_context_revision, output_context_revision, step_count, tool_call_count,",
    "usage_json, final_state_json, result_json, error_code, error_message,",
    "error_retryable, started_at, updated_at, completed_at",
    "FROM workstream_resolution_activities WHERE activity_id = ?",
  ].join(" ")).get(activityId) as ActivityRow | undefined;
  return row ? activityFromRow(row) : undefined;
}

export function readWorkstreamResolutionByRun(
  database: ContextDatabase,
  runId: string,
): WorkstreamResolutionActivity | undefined {
  const row = database.prepare([
    "SELECT activity_id, run_id, stream_id, prior_activity_id, status, input_json,",
    "input_context_revision, output_context_revision, step_count, tool_call_count,",
    "usage_json, final_state_json, result_json, error_code, error_message,",
    "error_retryable, started_at, updated_at, completed_at",
    "FROM workstream_resolution_activities WHERE run_id = ?",
  ].join(" ")).get(runId) as ActivityRow | undefined;
  return row ? activityFromRow(row) : undefined;
}

export function readLatestPendingWorkstreamResolution(
  database: ContextDatabase,
  streamId: string,
): WorkstreamResolutionActivity | undefined {
  const row = database.prepare([
    "SELECT activity_id, run_id, stream_id, prior_activity_id, status, input_json,",
    "input_context_revision, output_context_revision, step_count, tool_call_count,",
    "usage_json, final_state_json, result_json, error_code, error_message,",
    "error_retryable, started_at, updated_at, completed_at",
    "FROM workstream_resolution_activities",
    "WHERE stream_id = ? AND status = 'needs_user_input'",
    "ORDER BY completed_at DESC, activity_id DESC LIMIT 1",
  ].join(" ")).get(streamId) as ActivityRow | undefined;
  return row ? activityFromRow(row) : undefined;
}

export function readWorkstreamResolutionProjection(
  database: ContextDatabase,
  input: { runId?: string; streamId: string },
): WorkstreamResolutionProjection | undefined {
  const activity = input.runId
    ? readWorkstreamResolutionByRun(database, input.runId)
    : undefined;
  const selected = activity ?? readLatestPendingWorkstreamResolution(database, input.streamId);
  if (!selected) return undefined;
  return {
    activityId: selected.activityId,
    runId: selected.runId,
    status: selected.status,
    purpose: selected.input.purpose,
    stepCount: selected.stepCount,
    ...(selected.result ? { result: selected.result } : {}),
    updatedAt: selected.updatedAt,
  };
}

export function insertWorkstreamResolutionStep(
  database: ContextDatabase,
  activityId: string,
  record: WorkstreamResolutionStepRecord,
): WorkstreamResolutionActivity {
  return database.transaction(() => {
    const activity = requireWorkstreamResolutionActivity(database, activityId);
    const existing = readWorkstreamResolutionStep(database, activityId, record.step);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw invalid("Resolution step already exists with different content.", { activityId, step: record.step });
      }
      return activity;
    }
    if (record.step !== activity.stepCount + 1) {
      throw invalid("Resolution steps must be recorded contiguously.", {
        activityId,
        expectedStep: activity.stepCount + 1,
        actualStep: record.step,
      });
    }
    if (activity.status !== "running") {
      validateTerminalStep(activity, record);
      const terminalAlreadyRecorded = readWorkstreamResolutionSteps(database, activityId)
        .some((step) => step.status === "completed"
          && step.toolCalls.some((call) => isCompletedTerminalToolCall(call)));
      if (terminalAlreadyRecorded) {
        throw invalid("Resolution activity already has its terminal step.", { activityId });
      }
    }
    database.prepare([
      "INSERT INTO workstream_resolution_steps(",
      "activity_id, step, record_version, status, context_json, decision_json,",
      "tool_calls_json, verification_json, state_after_json, usage_json, created_at",
      ") VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" ")).run(
      activityId,
      record.step,
      record.status,
      JSON.stringify(record.context),
      JSON.stringify(record.decision),
      JSON.stringify(record.toolCalls),
      JSON.stringify(record.verification),
      JSON.stringify(record.stateAfter),
      record.usage ? JSON.stringify(record.usage) : null,
      record.createdAt,
    );
    const usage = addUsage(activity.usage, record.usage);
    database.prepare([
      "UPDATE workstream_resolution_activities",
      "SET step_count = ?, tool_call_count = tool_call_count + ?, usage_json = ?, updated_at = ?",
      "WHERE activity_id = ?",
    ].join(" ")).run(
      record.step,
      record.toolCalls.length,
      JSON.stringify(usage),
      record.createdAt,
      activityId,
    );
    return requireWorkstreamResolutionActivity(database, activityId);
  });
}

function validateTerminalStep(
  activity: WorkstreamResolutionActivity,
  record: WorkstreamResolutionStepRecord,
): void {
  const calls = record.toolCalls.filter(isTerminalToolCall);
  if (calls.length !== 1 || record.toolCalls.length !== 1) {
    throw invalid("A terminal resolution activity accepts exactly one matching terminal step.", {
      activityId: activity.activityId,
    });
  }
  if (record.status !== "completed" || !isCompletedTerminalToolCall(calls[0])) {
    throw invalid("A terminal resolution activity requires one completed terminal tool call.", {
      activityId: activity.activityId,
    });
  }
  const tool = typeof calls[0] === "object" && calls[0] !== null
    ? String((calls[0] as Record<string, unknown>)["tool"] ?? "")
    : "";
  const expected = activity.status === "resolved"
    ? new Set(["resolution_activate_workstream", "resolution_create_workstream"])
    : activity.status === "needs_user_input"
      ? new Set(["resolution_needs_user_input"])
      : new Set<string>();
  if (!expected.has(tool)) {
    throw invalid("Terminal resolution step does not match the activity outcome.", {
      activityId: activity.activityId,
      status: activity.status,
      tool,
    });
  }
}

function isTerminalToolCall(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const tool = (value as Record<string, unknown>)["tool"];
  return tool === "resolution_activate_workstream"
    || tool === "resolution_create_workstream"
    || tool === "resolution_needs_user_input";
}

function isCompletedTerminalToolCall(value: unknown): boolean {
  if (!isTerminalToolCall(value)) return false;
  return (value as Record<string, unknown>)["status"] === "completed";
}

export function readWorkstreamResolutionSteps(
  database: ContextDatabase,
  activityId: string,
): WorkstreamResolutionStepRecord[] {
  const rows = database.prepare([
    "SELECT step, record_version, status, context_json, decision_json, tool_calls_json,",
    "verification_json, state_after_json, usage_json, created_at",
    "FROM workstream_resolution_steps WHERE activity_id = ? ORDER BY step",
  ].join(" ")).all(activityId) as unknown as StepRow[];
  return rows.map(stepFromRow);
}

export function finishWorkstreamResolutionActivity(
  database: ContextDatabase,
  input: {
    activityId: string;
    result: WorkstreamResolutionResult;
    finalState: unknown;
    at: string;
  },
): WorkstreamResolutionActivity {
  const activity = requireWorkstreamResolutionActivity(database, input.activityId);
  if (activity.status !== "running") {
    if (JSON.stringify(activity.result) === JSON.stringify(input.result)) return activity;
    throw invalid("Resolution activity is already terminal.", {
      activityId: input.activityId,
      status: activity.status,
    });
  }
  const error = input.result.status === "failed" || input.result.status === "interrupted"
    ? input.result
    : undefined;
  database.prepare([
    "UPDATE workstream_resolution_activities",
    "SET status = ?, final_state_json = ?, result_json = ?, error_code = ?,",
    "error_message = ?, error_retryable = ?, updated_at = ?, completed_at = ?",
    "WHERE activity_id = ? AND status = 'running'",
  ].join(" ")).run(
    input.result.status,
    JSON.stringify(input.finalState),
    JSON.stringify(input.result),
    error?.code ?? null,
    error?.message ?? null,
    error ? (error.retryable ? 1 : 0) : null,
    input.at,
    input.at,
    input.activityId,
  );
  return requireWorkstreamResolutionActivity(database, input.activityId);
}

export function setWorkstreamResolutionOutputRevision(
  database: ContextDatabase,
  activityId: string,
  contextRevision: string,
  at: string,
): WorkstreamResolutionActivity {
  database.prepare([
    "UPDATE workstream_resolution_activities",
    "SET output_context_revision = ?, updated_at = ? WHERE activity_id = ?",
  ].join(" ")).run(contextRevision, at, activityId);
  return requireWorkstreamResolutionActivity(database, activityId);
}

export function interruptRunningWorkstreamResolutions(
  database: ContextDatabase,
  at: string,
): string[] {
  const rows = database.prepare([
    "SELECT activity_id FROM workstream_resolution_activities",
    "WHERE status = 'running' ORDER BY started_at, activity_id",
  ].join(" ")).all() as unknown as Array<{ activity_id: string }>;
  for (const row of rows) {
    const result: WorkstreamResolutionResult = {
      status: "interrupted",
      code: "WORKSTREAM_RESOLUTION_INTERRUPTED",
      message: "Workstream resolution was interrupted before it reached a terminal result.",
      retryable: true,
    };
    database.prepare([
      "UPDATE workstream_resolution_activities",
      "SET status = 'interrupted', result_json = ?, error_code = ?, error_message = ?,",
      "error_retryable = 1, updated_at = ?, completed_at = ?",
      "WHERE activity_id = ? AND status = 'running'",
    ].join(" ")).run(
      JSON.stringify(result),
      result.code,
      result.message,
      at,
      at,
      row.activity_id,
    );
  }
  return rows.map((row) => row.activity_id);
}

function readWorkstreamResolutionStep(
  database: ContextDatabase,
  activityId: string,
  step: number,
): WorkstreamResolutionStepRecord | undefined {
  const row = database.prepare([
    "SELECT step, record_version, status, context_json, decision_json, tool_calls_json,",
    "verification_json, state_after_json, usage_json, created_at",
    "FROM workstream_resolution_steps WHERE activity_id = ? AND step = ?",
  ].join(" ")).get(activityId, step) as StepRow | undefined;
  return row ? stepFromRow(row) : undefined;
}

function stepFromRow(row: StepRow): WorkstreamResolutionStepRecord {
  return {
    version: Number(row.record_version) as 1,
    step: Number(row.step),
    status: row.status,
    context: JSON.parse(row.context_json) as unknown,
    decision: JSON.parse(row.decision_json) as unknown,
    toolCalls: JSON.parse(row.tool_calls_json) as unknown[],
    verification: JSON.parse(row.verification_json) as unknown,
    stateAfter: JSON.parse(row.state_after_json) as unknown,
    ...(row.usage_json
      ? { usage: JSON.parse(row.usage_json) as WorkstreamResolutionUsage }
      : {}),
    createdAt: row.created_at,
  };
}

function activityFromRow(row: ActivityRow): WorkstreamResolutionActivity {
  return {
    activityId: row.activity_id,
    runId: row.run_id,
    streamId: row.stream_id,
    ...(row.prior_activity_id ? { priorActivityId: row.prior_activity_id } : {}),
    status: row.status,
    input: JSON.parse(row.input_json) as WorkstreamResolutionActivity["input"],
    inputContextRevision: row.input_context_revision,
    ...(row.output_context_revision ? { outputContextRevision: row.output_context_revision } : {}),
    stepCount: Number(row.step_count),
    toolCallCount: Number(row.tool_call_count),
    usage: JSON.parse(row.usage_json) as WorkstreamResolutionUsage,
    ...(row.final_state_json ? { finalState: JSON.parse(row.final_state_json) as unknown } : {}),
    ...(row.result_json
      ? { result: JSON.parse(row.result_json) as WorkstreamResolutionResult }
      : {}),
    ...(row.error_code && row.error_message
      ? {
          error: {
            code: row.error_code,
            message: row.error_message,
            retryable: row.error_retryable === 1,
          },
        }
      : {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function requireWorkstreamResolutionActivity(
  database: ContextDatabase,
  activityId: string,
): WorkstreamResolutionActivity {
  const activity = readWorkstreamResolutionActivity(database, activityId);
  if (!activity) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_RESOLUTION_NOT_FOUND",
      message: "Workstream resolution activity does not exist.",
      details: { activityId },
    });
  }
  return activity;
}

function activityIdForRun(runId: string): string {
  return "WR-" + createHash("sha256").update(runId).digest("hex").slice(0, 24).toUpperCase();
}

function addUsage(
  current: WorkstreamResolutionUsage,
  next: WorkstreamResolutionUsage | undefined,
): WorkstreamResolutionUsage {
  if (!next) return current;
  return {
    provider: next.provider ?? current.provider,
    model: next.model ?? current.model,
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    ...((current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0) > 0
      ? { cachedInputTokens: (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0) }
      : {}),
    ...((current.costUsd ?? 0) + (next.costUsd ?? 0) > 0
      ? { costUsd: (current.costUsd ?? 0) + (next.costUsd ?? 0) }
      : {}),
  };
}

function invalid(message: string, details: Record<string, unknown>): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "INVALID_REQUEST",
    message,
    details,
  });
}
