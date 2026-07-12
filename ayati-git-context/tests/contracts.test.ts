import { describe, expect, it } from "vitest";
import {
  isAppendConversationRequest,
  isCreateTaskRequest,
  isEnsureActiveSessionRequest,
  isRecordRunStepRequest,
  isRequestEnvelope,
  isStartRunRequest,
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
