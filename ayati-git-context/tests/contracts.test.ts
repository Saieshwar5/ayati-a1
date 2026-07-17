import { describe, expect, it } from "vitest";
import {
  isAcquireMutationAuthorityRequest,
  isAdoptTaskReferenceRequest,
  isAppendConversationRequest,
  isBindTaskAttachmentsRequest,
  isCheckpointMutationRequest,
  isCreateTaskRequest,
  isEnsureActiveSessionRequest,
  isFinalizeSessionRunRequest,
  isFinalizeTaskRunRequest,
  isMountTaskRequest,
  isPlanTaskRequestRouteRequest,
  isRecordRunStepRequest,
  isRecordSessionAttachmentsRequest,
  isRequestEnvelope,
  isSnapshotTaskRunEvidenceRequest,
  isStartRunRequest,
  isVerifyMutationRequest,
} from "../src/contracts.js";
import {
  GitContextServiceError,
  isGitContextErrorResponse,
} from "../src/errors.js";

describe("Git Context Engine contracts", () => {
  it("requires an idempotency request id", () => {
    expect(isRequestEnvelope({ requestId: "REQ-1" })).toBe(true);
    expect(isRequestEnvelope({ requestId: " " })).toBe(false);
    expect(isRequestEnvelope({})).toBe(false);
  });

  it("validates ensure-active session requests", () => {
    expect(isEnsureActiveSessionRequest({
      requestId: "REQ-1",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
    })).toBe(true);
    expect(isEnsureActiveSessionRequest({
      requestId: "REQ-1",
      date: "",
      timezone: "Asia/Kolkata",
      agentId: "local",
    })).toBe(false);
  });

  it("validates conversation append roles and required content", () => {
    expect(isAppendConversationRequest({
      requestId: "REQ-2",
      sessionId: "S-1",
      role: "system_event",
      content: "Midnight rollover requested.",
      at: "2026-07-12T00:00:00+05:30",
    })).toBe(true);
    expect(isAppendConversationRequest({
      requestId: "REQ-2",
      sessionId: "S-1",
      role: "system",
      content: "Unsupported role.",
      at: "2026-07-12T00:00:00+05:30",
    })).toBe(false);
  });

  it("accepts complete conversation message bodies without a persistence length cap", () => {
    const longContent = "complete-message-body\n".repeat(2_000) + "END-OF-MESSAGE";

    for (const role of ["user", "assistant", "system_event"] as const) {
      expect(isAppendConversationRequest({
        requestId: `REQ-long-${role}`,
        sessionId: "S-1",
        role,
        content: longContent,
        at: "2026-07-12T00:00:00+05:30",
      })).toBe(true);
    }
  });

  it("validates bounded task creation requests", () => {
    expect(isCreateTaskRequest({
      requestId: "REQ-task",
      sessionId: "S-20260712-local",
      title: "Coffee Shop Website",
      objective: "Build a responsive coffee-shop website.",
      placement: { mode: "requested", workingDirectory: "workspace/coffee-shop" },
      at: "2026-07-12T10:00:00+05:30",
    })).toBe(true);
    expect(isCreateTaskRequest({
      requestId: "REQ-managed-task",
      sessionId: "S-20260712-local",
      title: "Managed Task",
      objective: "Build something in an Ayati-managed directory.",
      placement: { mode: "managed" },
      at: "2026-07-12T10:00:00+05:30",
    })).toBe(true);
    expect(isCreateTaskRequest({
      requestId: "REQ-missing-placement",
      sessionId: "S-20260712-local",
      title: "Missing Placement",
      objective: "This request must be rejected.",
      at: "2026-07-12T10:00:00+05:30",
    })).toBe(false);
    expect(isCreateTaskRequest({
      requestId: "REQ-task",
      sessionId: "S-20260712-local",
      title: " ",
      objective: "Build something.",
      placement: { mode: "managed" },
      at: "2026-07-12T10:00:00+05:30",
    })).toBe(false);
  });

  it("validates narrow V1 task request route plans", () => {
    const base = {
      requestId: "REQ-route",
      sessionId: "S-20260717-local",
      conversationId: "C-000001",
      runId: "R-20260717-0001",
      taskId: "T-20260717-0001",
      expectedTaskHead: "a".repeat(40),
      at: "2026-07-17T16:00:00+05:30",
    };
    expect(isPlanTaskRequestRouteRequest({
      ...base,
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "Continue the unfinished bounded outcome.",
      },
    })).toBe(true);
    expect(isPlanTaskRequestRouteRequest({
      ...base,
      route: {
        kind: "create_active_request",
        reason: "Start the next bounded outcome in this task.",
        title: "Next lesson",
        request: "Create the next lesson.",
        acceptance: ["The lesson is verified."],
        constraints: [],
      },
    })).toBe(true);
    expect(isPlanTaskRequestRouteRequest({
      ...base,
      route: { kind: "create_queued_request", reason: "Not a mutating route." },
    })).toBe(false);
    expect(isPlanTaskRequestRouteRequest({
      ...base,
      taskId: "W-20260717-0001",
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "Legacy tasks do not use this writer.",
      },
    })).toBe(false);
  });

  it("validates task mount identity and expected HEAD", () => {
    expect(isMountTaskRequest({
      requestId: "REQ-mount",
      sessionId: "S-20260712-local",
      taskId: "W-20260712-0001",
      expectedTaskHead: "a".repeat(40),
      at: "2026-07-12T10:01:00+05:30",
    })).toBe(true);
    expect(isMountTaskRequest({
      requestId: "REQ-mount",
      sessionId: "S-20260712-local",
      taskId: "../../escape",
      at: "2026-07-12T10:01:00+05:30",
    })).toBe(false);
  });

  it("validates attachment retention, binding, and adoption requests", () => {
    expect(isRecordSessionAttachmentsRequest({
      requestId: "REQ-attachments",
      sessionId: "S-20260717-local",
      conversationId: "C-000001",
      attachments: [{
        sessionAssetId: "SA-contract-file",
        kind: "file",
        name: "brief.txt",
        source: "local_path",
        status: "ready",
        storedPath: "/managed/documents/brief.txt",
        sizeBytes: 12,
        checksum: "a".repeat(64),
        createdAt: "2026-07-17T10:00:00+05:30",
        lastUsedAt: "2026-07-17T10:00:00+05:30",
      }],
      at: "2026-07-17T10:00:00+05:30",
    })).toBe(true);
    expect(isRecordSessionAttachmentsRequest({
      requestId: "REQ-empty-attachments",
      sessionId: "S-20260717-local",
      conversationId: "C-000001",
      attachments: [],
      at: "2026-07-17T10:00:00+05:30",
    })).toBe(false);
    expect(isBindTaskAttachmentsRequest({
      requestId: "REQ-bind-attachments",
      sessionId: "S-20260717-local",
      conversationId: "C-000001",
      runId: "R-20260717-0001",
      taskId: "T-20260717-0001",
      at: "2026-07-17T10:01:00+05:30",
    })).toBe(true);
    expect(isBindTaskAttachmentsRequest({
      requestId: "REQ-bind-legacy-task",
      sessionId: "S-20260717-local",
      conversationId: "C-000001",
      runId: "R-20260717-0001",
      taskId: "W-20260717-0001",
      at: "2026-07-17T10:01:00+05:30",
    })).toBe(true);
    expect(isBindTaskAttachmentsRequest({
      requestId: "REQ-bind-invalid-task",
      sessionId: "S-20260717-local",
      conversationId: "C-000001",
      runId: "R-20260717-0001",
      taskId: "task-1",
      at: "2026-07-17T10:01:00+05:30",
    })).toBe(false);
    expect(isAdoptTaskReferenceRequest({
      requestId: "REQ-adopt-reference",
      authorityId: "A-1",
      lockToken: "secret-token",
      referenceId: "REF-0001",
      destinationPath: "inputs/brief.txt",
      at: "2026-07-17T10:02:00+05:30",
    })).toBe(true);
    expect(isAdoptTaskReferenceRequest({
      requestId: "REQ-invalid-reference",
      authorityId: "A-1",
      lockToken: "secret-token",
      referenceId: "brief.txt",
      destinationPath: "inputs/brief.txt",
      at: "2026-07-17T10:02:00+05:30",
    })).toBe(false);
  });

  it("validates mutation authority targets and verification requests", () => {
    expect(isAcquireMutationAuthorityRequest({
      requestId: "REQ-authority",
      sessionId: "S-20260712-local",
      runId: "R-20260712-0001",
      taskId: "W-20260712-0001",
      targets: [{ path: "src/app.ts", kind: "file" }],
      at: "2026-07-12T10:02:00+05:30",
    })).toBe(true);
    expect(isAcquireMutationAuthorityRequest({
      requestId: "REQ-v1-authority",
      sessionId: "S-20260717-local",
      runId: "R-20260717-0001",
      taskId: "T-20260717-0001",
      taskRequestId: "R-0001",
      expectedTaskHead: "a".repeat(40),
      targets: [{ path: "src/app.ts", kind: "file" }],
      at: "2026-07-17T10:02:00+05:30",
    })).toBe(true);
    expect(isAcquireMutationAuthorityRequest({
      requestId: "REQ-authority",
      sessionId: "S-20260712-local",
      runId: "R-20260712-0001",
      taskId: "W-20260712-0001",
      targets: [],
      at: "2026-07-12T10:02:00+05:30",
    })).toBe(false);
    expect(isVerifyMutationRequest({
      requestId: "REQ-verify",
      authorityId: "A-1",
      lockToken: "secret-token",
      toolStatus: "completed",
      at: "2026-07-12T10:03:00+05:30",
    })).toBe(true);
    expect(isCheckpointMutationRequest({
      requestId: "REQ-checkpoint",
      authorityId: "A-1",
      lockToken: "secret-token",
      purpose: "Create the application entry point.",
      conversationId: "C-000001",
      conversationHash: "sha256:" + "a".repeat(64),
      at: "2026-07-12T10:04:00+05:30",
    })).toBe(true);
    expect(isCheckpointMutationRequest({
      requestId: "REQ-checkpoint",
      authorityId: "A-1",
      lockToken: "secret-token",
      purpose: "Create the application entry point.",
      conversationId: "C-000001",
      conversationHash: "not-a-hash",
      at: "2026-07-12T10:04:00+05:30",
    })).toBe(false);
  });

  it("validates run start requests", () => {
    expect(isStartRunRequest({
      requestId: "REQ-3",
      sessionId: "S-1",
      conversationId: "C-1",
      trigger: "user",
      workState: emptyRunWorkState(),
    })).toBe(true);
    expect(isStartRunRequest({
      requestId: "REQ-3",
      sessionId: "S-1",
      conversationId: "C-1",
      trigger: "timer",
      workState: emptyRunWorkState(),
    })).toBe(false);
  });

  it("validates task-run evidence snapshot ownership", () => {
    expect(isSnapshotTaskRunEvidenceRequest({
      requestId: "REQ-evidence",
      sessionId: "S-20260712-local",
      runId: "R-20260712-0001",
      taskId: "W-20260712-0001",
      at: "2026-07-12T10:05:00+05:30",
    })).toBe(true);
    expect(isSnapshotTaskRunEvidenceRequest({
      requestId: "REQ-evidence",
      sessionId: "S-20260712-local",
      runId: "R-20260712-0001",
      taskId: "escape",
      at: "2026-07-12T10:05:00+05:30",
    })).toBe(false);
  });

  it("validates bounded task-run finalization outcomes", () => {
    const completeAssistantResponse = "complete assistant response\n".repeat(1_000)
      + "END-OF-ASSISTANT-RESPONSE";
    expect(isFinalizeTaskRunRequest({
      requestId: "REQ-finalize",
      sessionId: "S-20260712-local",
      runId: "R-20260712-0001",
      taskId: "W-20260712-0001",
      outcome: "incomplete",
      conversationSummary: "The user requested a task update and reviewed the partial result.",
      summary: "Created the verified files but validation still needs work.",
      validation: "failed",
      next: "Repair the validation failure in a new run.",
      completion: {
        accepted: false,
        assets: [],
        missing: ["Passing validation"],
        failures: ["Validation failed"],
        criteria: [{ criterion: "Validation passes.", passed: false }],
      },
      assistantResponse: completeAssistantResponse,
      at: "2026-07-12T10:06:00+05:30",
    })).toBe(true);
    expect(isFinalizeTaskRunRequest({
      requestId: "REQ-finalize-v1",
      sessionId: "S-20260717-local",
      runId: "R-20260717-0001",
      taskId: "T-20260717-0001",
      outcome: "done",
      conversationSummary: "The V1 task work is complete.",
      summary: "The verified V1 outcome is durable.",
      validation: "passed",
      completion: {
        accepted: true,
        assets: [],
        missing: [],
        failures: [],
        criteria: [{ criterion: "The work is verified.", passed: true }],
      },
      assistantResponse: "The V1 task is complete.",
      at: "2026-07-17T10:06:00+05:30",
    })).toBe(true);
    expect(isFinalizeTaskRunRequest({
      requestId: "REQ-finalize",
      sessionId: "S-20260712-local",
      runId: "R-20260712-0001",
      taskId: "W-20260712-0001",
      outcome: "almost_done",
      conversationSummary: "Invalid outcome conversation.",
      summary: "Invalid outcome.",
      validation: "passed",
      completion: {
        accepted: false,
        assets: [],
        missing: [],
        failures: [],
        criteria: [],
      },
      assistantResponse: "Invalid.",
      at: "2026-07-12T10:06:00+05:30",
    })).toBe(false);
  });

  it("validates durable run-step records", () => {
    expect(isRecordRunStepRequest({
      requestId: "REQ-4",
      sessionId: "S-1",
      runId: "R-1",
      step: 1,
      tool: "read_files",
      toolEffect: "read_only",
      purpose: "Inspect the current implementation.",
      status: "completed",
      workState: emptyRunWorkState(),
      at: "2026-07-12T10:00:00+05:30",
    })).toBe(true);
    expect(isRecordRunStepRequest({
      requestId: "REQ-4",
      sessionId: "S-1",
      runId: "R-1",
      step: 0,
      tool: "read_files",
      toolEffect: "read_only",
      purpose: "",
      status: "running",
      workState: emptyRunWorkState(),
      at: "2026-07-12T10:00:00+05:30",
    })).toBe(false);
  });

  it("validates session-run finalization with done WorkState", () => {
    const completeAssistantResponse = "complete read-only response\n".repeat(1_000)
      + "END-OF-ASSISTANT-RESPONSE";
    expect(isFinalizeSessionRunRequest({
      requestId: "REQ-finalize-session",
      sessionId: "S-20260712-local",
      runId: "R-20260712-0001",
      assistantResponse: completeAssistantResponse,
      workState: { ...emptyRunWorkState(), status: "done" },
      at: "2026-07-12T10:00:01+05:30",
    })).toBe(true);
    expect(isFinalizeSessionRunRequest({
      requestId: "REQ-finalize-session",
      sessionId: "S-20260712-local",
      runId: "R-20260712-0001",
      assistantResponse: "Here is what I found.",
      workState: emptyRunWorkState(),
      at: "2026-07-12T10:00:01+05:30",
    })).toBe(false);
  });

  it("serializes structured service errors", () => {
    const error = new GitContextServiceError({
      code: "TASK_LOCKED",
      message: "Task is already owned.",
      retryable: true,
      details: { taskId: "W-1" },
    });
    expect(error.toResponse()).toEqual({
      error: {
        code: "TASK_LOCKED",
        message: "Task is already owned.",
        retryable: true,
        details: { taskId: "W-1" },
      },
    });
    expect(isGitContextErrorResponse(error.toResponse())).toBe(true);
  });
});

function emptyRunWorkState() {
  return {
    status: "not_done" as const,
    summary: "",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}
