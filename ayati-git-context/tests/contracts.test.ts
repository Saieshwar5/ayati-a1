import { describe, expect, it } from "vitest";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  isAcquireMutationAuthorityRequest,
  isActivateTaskForRunRequest,
  isCreateTaskForRunRequest,
  isEnsureActiveSessionRequest,
  isFinalizeRunRequest,
  isPlanTaskRequestRouteRequest,
  isPrepareContextTurnRequest,
  isRecordRunStepRequest,
  isRequestEnvelope,
  isVerifyMutationRequest,
  type FinalizeRunRequest,
  type RunStepRecord,
  type RunWorkStateInput,
} from "../src/contracts.js";
import {
  GitContextServiceError,
  isGitContextErrorResponse,
} from "../src/errors.js";

describe("Git Context protocol 35 contracts", () => {
  it("exposes the version-3 autonomous-workstream protocol", () => {
    expect(GIT_CONTEXT_PROTOCOL_VERSION).toBe(35);
    expect(isRequestEnvelope({ requestId: "REQ-1" })).toBe(true);
    expect(isRequestEnvelope({ requestId: " " })).toBe(false);
  });

  it("validates session bootstrap and atomic turn preparation", () => {
    expect(isEnsureActiveSessionRequest({
      requestId: "REQ-session",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
    })).toBe(true);
    expect(isPrepareContextTurnRequest({
      requestId: "REQ-turn",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Inspect the current implementation.",
      at: "2026-07-19T10:00:00+05:30",
    })).toBe(true);
    expect(isPrepareContextTurnRequest({
      requestId: "REQ-turn",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "assistant",
      content: "Invalid ingress role.",
      at: "2026-07-19T10:00:00+05:30",
    })).toBe(false);
  });

  it("requires an existing run identity when creating a task", () => {
    const valid = {
      requestId: "REQ-create-task",
      sessionId: "S-20260719-local",
      conversationId: "S-20260719-local-C-000001",
      runId: "R-20260719-0001",
      title: "Coffee Shop Website",
      objective: "Build a responsive coffee-shop website.",
      placement: { mode: "managed" as const },
      at: "2026-07-19T10:01:00+05:30",
    };
    expect(isCreateTaskForRunRequest(valid)).toBe(true);
    expect(isCreateTaskForRunRequest({ ...valid, runId: undefined })).toBe(false);
    expect(isCreateTaskForRunRequest({ ...valid, conversationId: undefined })).toBe(false);
    expect(isCreateTaskForRunRequest({
      ...valid,
      placement: { mode: "requested", workingDirectory: "workspace/coffee-shop" },
    })).toBe(true);
  });

  it("requires an explicit continue-or-create decision when activating a task", () => {
    const base = {
      requestId: "REQ-activate-task",
      sessionId: "S-20260719-local",
      conversationId: "S-20260719-local-C-000001",
      runId: "R-20260719-0001",
      taskId: "T-20260719-0001",
      expectedTaskHead: "a".repeat(40),
      at: "2026-07-19T10:01:00+05:30",
    };
    expect(isActivateTaskForRunRequest(base)).toBe(false);
    expect(isActivateTaskForRunRequest({
      ...base,
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "Continue the active request.",
      },
    })).toBe(true);
    expect(isActivateTaskForRunRequest({
      ...base,
      route: {
        kind: "create_active_request",
        reason: "Start a separate bounded outcome.",
        title: "Add a lesson",
        request: "Add and verify the next lesson.",
        acceptance: ["The lesson is verified."],
        constraints: [],
      },
    })).toBe(true);
  });

  it("validates narrow request-route plans", () => {
    const base = {
      requestId: "REQ-route",
      sessionId: "S-20260719-local",
      conversationId: "S-20260719-local-C-000001",
      runId: "R-20260719-0001",
      taskId: "T-20260719-0001",
      expectedTaskHead: "a".repeat(40),
      at: "2026-07-19T10:01:00+05:30",
    };
    expect(isPlanTaskRequestRouteRequest({
      ...base,
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "Continue the active request.",
      },
    })).toBe(true);
    expect(isPlanTaskRequestRouteRequest({
      ...base,
      route: { kind: "create_queued_request", reason: "Unsupported." },
    })).toBe(false);
  });

  it("validates ordered structured step records", () => {
    const record: RunStepRecord = {
      version: 1,
      step: 1,
      status: "completed",
      summary: "Inspected the implementation.",
      decision: { kind: "tool_call" },
      action: { tool: "read_files" },
      toolCalls: [{
        callId: "call-1",
        tool: "read_files",
        purpose: "Inspect the current implementation.",
        toolPurpose: "read",
        toolEffect: "read_only",
        status: "success",
        input: { paths: ["src/app.ts"] },
        output: { files: ["src/app.ts"] },
      }],
      verification: { passed: true },
      workStateAfter: workState(),
      createdAt: "2026-07-19T10:02:00+05:30",
    };
    expect(isRecordRunStepRequest({
      requestId: "REQ-step",
      sessionId: "S-20260719-local",
      runId: "R-20260719-0001",
      record,
    })).toBe(true);
    expect(isRecordRunStepRequest({
      requestId: "REQ-plan-failure",
      sessionId: "S-20260719-local",
      runId: "R-20260719-0001",
      record: {
        ...record,
        status: "failed",
        toolCalls: [],
        verification: { passed: false, error: "Action plan was invalid." },
      },
    })).toBe(true);
    expect(isRecordRunStepRequest({
      requestId: "REQ-step",
      sessionId: "S-20260719-local",
      runId: "R-20260719-0001",
      record: { ...record, step: 0 },
    })).toBe(false);
    expect(isRecordRunStepRequest({
      requestId: "REQ-step",
      sessionId: "S-20260719-local",
      runId: "R-20260719-0001",
      record: {
        ...record,
        toolCalls: [{ ...record.toolCalls[0], toolEffect: "unknown" }],
      },
    })).toBe(false);
  });

  it("enforces truthful outcome and stop-reason pairs", () => {
    const base = finalization();
    expect(isFinalizeRunRequest(base)).toBe(true);
    expect(isFinalizeRunRequest({
      ...base,
      outcome: "incomplete",
      stopReason: "run_limit",
      workState: { ...workState(), status: "not_done" },
    })).toBe(true);
    expect(isFinalizeRunRequest({
      ...base,
      outcome: "done",
      stopReason: "run_limit",
    })).toBe(false);
    expect(isFinalizeRunRequest({
      ...base,
      outcome: "needs_user_input",
      stopReason: "needs_user_input",
      workState: {
        ...workState(),
        status: "needs_user_input",
        userInputNeeded: ["Which task should own this work?"],
      },
    })).toBe(true);
  });

  it("requires accepted completion evidence for a done task-bound payload", () => {
    const base = finalization();
    const completion = {
      accepted: true,
      assets: [],
      missing: [],
      failures: [],
      criteria: [{ criterion: "The requested result is verified.", passed: true }],
    };
    expect(isFinalizeRunRequest({ ...base, task: { completion } })).toBe(true);
    expect(isFinalizeRunRequest({
      ...base,
      task: { completion: { ...completion, accepted: false } },
    })).toBe(false);
    expect(isFinalizeRunRequest({
      ...base,
      outcome: "failed",
      stopReason: "failed",
      validation: "failed",
      workState: { ...workState(), status: "not_done" },
      task: { completion: { ...completion, accepted: false } },
    })).toBe(true);
  });

  it("validates bound mutation authority and verification requests", () => {
    expect(isAcquireMutationAuthorityRequest({
      requestId: "REQ-authority",
      sessionId: "S-20260719-local",
      runId: "R-20260719-0001",
      taskId: "T-20260719-0001",
      taskRequestId: "R-0001",
      expectedTaskHead: "a".repeat(40),
      targets: [{ path: "src/app.ts", kind: "file" }],
      at: "2026-07-19T10:02:00+05:30",
    })).toBe(true);
    expect(isAcquireMutationAuthorityRequest({
      requestId: "REQ-authority",
      sessionId: "S-20260719-local",
      runId: "R-20260719-0001",
      taskId: "T-20260719-0001",
      targets: [],
      at: "2026-07-19T10:02:00+05:30",
    })).toBe(false);
    expect(isVerifyMutationRequest({
      requestId: "REQ-verify",
      authorityId: "A-1",
      lockToken: "secret-token",
      toolStatus: "completed",
      at: "2026-07-19T10:03:00+05:30",
    })).toBe(true);
  });

  it("serializes structured service errors", () => {
    const error = new GitContextServiceError({
      code: "TASK_LOCKED",
      message: "Task is already owned.",
      retryable: true,
      details: { taskId: "T-1" },
    });
    expect(error.toResponse()).toEqual({
      error: {
        code: "TASK_LOCKED",
        message: "Task is already owned.",
        retryable: true,
        details: { taskId: "T-1" },
      },
    });
    expect(isGitContextErrorResponse(error.toResponse())).toBe(true);
  });
});

function finalization(): FinalizeRunRequest {
  return {
    requestId: "REQ-finalize",
    sessionId: "S-20260719-local",
    runId: "R-20260719-0001",
    outcome: "done",
    stopReason: "completed",
    assistantResponse: "The requested result is complete.",
    conversationSummary: "The user requested and received a verified result.",
    summary: "The requested result is complete.",
    validation: "passed",
    workState: { ...workState(), status: "done" },
    at: "2026-07-19T10:04:00+05:30",
  };
}

function workState(): RunWorkStateInput {
  return {
    status: "not_done",
    summary: "Work is in progress.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}
