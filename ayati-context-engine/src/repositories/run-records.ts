import { createHash } from "node:crypto";
import type { ContextDatabase } from "../database/database.js";
import type {
  RecordRunStepRequest,
  RunContextRecord,
  RunOutcome,
  RunRef,
  RunStepContext,
  RunStopReason,
  RunWorkStateInput,
  WorkstreamBinding,
  ToolEffect,
  ToolPurpose,
} from "../contracts.js";
import { ContextEngineServiceError } from "../errors.js";
import { allocateStreamRunSequence } from "./agent-stream-records.js";
import {
  insertInitialRunWorkState,
  replaceRunWorkState,
} from "./run-work-state-records.js";

interface RunRow {
  run_id: string;
  stream_id: string;
  workstream_id: string | null;
  bound_request_id: string | null;
  workstream_bound_at: string | null;
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
  streamId: string;
  trigger: RunContextRecord["trigger"];
  workState: RunWorkStateInput;
  at: string;
}

export function createRun(database: ContextDatabase, input: CreateRunInput): RunRef {
  const active = readBlockingRun(database, input.streamId);
  if (active) {
    throw new ContextEngineServiceError({
      code: "RUN_ALREADY_ACTIVE",
      message: "Agent stream already has an active or recovery-required run.",
      details: { streamId: input.streamId, runId: active.runId },
    });
  }
  const sequence = allocateStreamRunSequence(database, input.streamId, input.at);
  const streamPart = createHash("sha256").update(input.streamId).digest("hex").slice(0, 8).toUpperCase();
  const runId = "RUN-" + streamPart + "-" + String(sequence).padStart(10, "0");
  database.prepare([
    "INSERT INTO runs(",
    "run_id, stream_id, workstream_id, bound_request_id, workstream_bound_at,",
    "run_sequence, status, stop_reason, trigger, started_at, completed_at, step_count",
    ") VALUES (?, ?, NULL, NULL, NULL, ?, 'running', NULL, ?, ?, NULL, 0)",
  ].join(" ")).run(
    runId,
    input.streamId,
    sequence,
    input.trigger,
    input.at,
  );
  insertInitialRunWorkState(database, runId, input.workState, input.at);
  return {
    runId,
    streamId: input.streamId,
  };
}

export function readActiveRun(database: ContextDatabase, streamId: string): RunRef | undefined {
  const row = database.prepare([
    "SELECT run_id, stream_id, workstream_id, bound_request_id, workstream_bound_at",
    "FROM runs WHERE stream_id = ? AND status = 'running' LIMIT 1",
  ].join(" ")).get(streamId) as RunRow | undefined;
  return row ? runRef(row) : undefined;
}

export function readBlockingRun(database: ContextDatabase, streamId: string): RunRef | undefined {
  const row = database.prepare([
    "SELECT run_id, stream_id, workstream_id, bound_request_id, workstream_bound_at",
    "FROM runs WHERE stream_id = ? AND status IN ('running', 'recovery_required') LIMIT 1",
  ].join(" ")).get(streamId) as RunRow | undefined;
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
    "SELECT run_id, stream_id, workstream_id, bound_request_id, workstream_bound_at",
    "FROM runs WHERE run_id = ?",
  ].join(" ")).get(runId) as RunRow | undefined;
  return row ? runRef(row) : undefined;
}

export function readRunEvidence(
  database: ContextDatabase,
  runId: string,
): RunEvidenceRecord | undefined {
  const row = database.prepare([
    "SELECT run_id, stream_id, workstream_id, bound_request_id, workstream_bound_at,",
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
    throw new ContextEngineServiceError({
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

export function bindActiveRunToWorkstream(
  database: ContextDatabase,
  input: {
    runId: string;
    workstreamId: string;
    requestId: string;
    at: string;
  },
): RunRef {
  const row = database.prepare([
    "SELECT run_id, stream_id, workstream_id, bound_request_id, workstream_bound_at",
    "FROM runs WHERE run_id = ? AND status = 'running'",
  ].join(" ")).get(input.runId) as RunRow | undefined;
  if (!row) {
    throw new ContextEngineServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Workstream selection requires the matching active run.",
      details: { runId: input.runId },
    });
  }
  if (row.workstream_id || row.bound_request_id || row.workstream_bound_at) {
    if (row.workstream_id === input.workstreamId && row.bound_request_id === input.requestId) {
      return runRef(row);
    }
    throw new ContextEngineServiceError({
      code: "RUN_WORKSTREAM_BINDING_IMMUTABLE",
      message: "Run is already bound to a different workstream or request.",
      details: {
        runId: input.runId,
        activeWorkstreamId: row.workstream_id,
        activeRequestId: row.bound_request_id,
        requestedWorkstreamId: input.workstreamId,
        requestedRequestId: input.requestId,
      },
    });
  }

  database.prepare([
    "UPDATE runs SET workstream_id = ?, bound_request_id = ?, workstream_bound_at = ? WHERE run_id = ?",
  ].join(" ")).run(input.workstreamId, input.requestId, input.at, input.runId);
  return {
    runId: input.runId,
    streamId: row.stream_id,
    workstreamBinding: {
      workstreamId: input.workstreamId,
      requestId: input.requestId,
      boundAt: input.at,
    },
  };
}

export function recordRunStep(
  database: ContextDatabase,
  input: RecordRunStepRequest,
): { step: RunStepContext; workState: ReturnType<typeof replaceRunWorkState> } {
  const run = database.prepare([
    "SELECT stream_id, workstream_id, bound_request_id, status, step_count FROM runs WHERE run_id = ?",
  ].join(" ")).get(input.runId) as {
    stream_id: string;
    workstream_id: string | null;
    bound_request_id: string | null;
    status: string;
    step_count: number;
  } | undefined;
  if (!run || run.status !== "running") {
    throw new ContextEngineServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Run is not active in its agent stream.",
      details: { runId: input.runId },
    });
  }
  const expectedStep = Number(run.step_count) + 1;
  if (input.record.step !== expectedStep) {
    throw new ContextEngineServiceError({
      code: "RUN_STEP_NOT_CONTIGUOUS",
      message: "Run steps must be recorded once in contiguous order.",
      details: { runId: input.runId, expectedStep, receivedStep: input.record.step },
    });
  }
  assertToolClassifications(input.record.toolCalls);
  const mutation = input.record.toolCalls.find((call) => call.toolPurpose === "mutation");
  if (mutation && (!run.workstream_id || !run.bound_request_id)) {
    throw new ContextEngineServiceError({
      code: "MUTATION_REQUIRES_WORKSTREAM_BINDING",
      message: "Mutation effects require an immutable workstream/request binding.",
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
  const workstreamBinding = workstreamBindingFromRow(row);
  return {
    runId: row.run_id,
    streamId: row.stream_id,
    ...(workstreamBinding ? { workstreamBinding } : {}),
  };
}

function workstreamBindingFromRow(row: RunRow): WorkstreamBinding | undefined {
  if (!row.workstream_id || !row.bound_request_id || !row.workstream_bound_at) return undefined;
  return {
    workstreamId: row.workstream_id,
    requestId: row.bound_request_id,
    boundAt: row.workstream_bound_at,
  };
}

function assertToolClassifications(
  calls: RunStepContext["toolCalls"],
): void {
  for (const call of calls) {
    if (!TOOL_PURPOSES.has(call.toolPurpose) || !TOOL_EFFECTS.has(call.toolEffect)) {
      throw new ContextEngineServiceError({
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
      throw new ContextEngineServiceError({
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
