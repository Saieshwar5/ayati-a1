import { describe, expect, it } from "vitest";
import {
  isAcquireMutationAuthorityRequest,
  isAppendConversationRequest,
  isCheckpointMutationRequest,
  isCreateTaskRequest,
  isEnsureActiveSessionRequest,
  isMountTaskRequest,
  isRecordRunStepRequest,
  isRequestEnvelope,
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

  it("validates bounded task creation requests", () => {
    expect(isCreateTaskRequest({
      requestId: "REQ-task",
      sessionId: "S-20260712-local",
      title: "Coffee Shop Website",
      objective: "Build a responsive coffee-shop website.",
      at: "2026-07-12T10:00:00+05:30",
    })).toBe(true);
    expect(isCreateTaskRequest({
      requestId: "REQ-task",
      sessionId: "S-20260712-local",
      title: " ",
      objective: "Build something.",
      at: "2026-07-12T10:00:00+05:30",
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
    })).toBe(true);
    expect(isStartRunRequest({
      requestId: "REQ-3",
      sessionId: "S-1",
      conversationId: "C-1",
      trigger: "timer",
    })).toBe(false);
  });

  it("validates durable run-step records", () => {
    expect(isRecordRunStepRequest({
      requestId: "REQ-4",
      sessionId: "S-1",
      runId: "R-1",
      step: 1,
      tool: "read_files",
      purpose: "Inspect the current implementation.",
      status: "completed",
      at: "2026-07-12T10:00:00+05:30",
    })).toBe(true);
    expect(isRecordRunStepRequest({
      requestId: "REQ-4",
      sessionId: "S-1",
      runId: "R-1",
      step: 0,
      tool: "read_files",
      purpose: "",
      status: "running",
      at: "2026-07-12T10:00:00+05:30",
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
