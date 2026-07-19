import { describe, expect, it } from "vitest";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  isActivateWorkstreamForRunRequest,
  isBindResourcesForRunRequest,
  isCreateWorkstreamForRunRequest,
  isEnsureActiveSessionRequest,
  isFinalizeRunRequest,
  isInspectResourceForRunRequest,
  isPlanWorkstreamRequestRouteRequest,
  isPrepareContextTurnRequest,
  isPrepareResourceMutationRequest,
  isRecordRunStepRequest,
  isRequestEnvelope,
  isVerifyResourceMutationRequest,
  type FinalizeRunRequest,
  type RunStepRecord,
  type RunWorkStateInput,
} from "../src/contracts.js";
import {
  GitContextServiceError,
  isGitContextErrorResponse,
} from "../src/errors.js";
import { RUN_FINALIZATION_LIMITS } from "../src/run-finalization-limits.js";

const AT = "2026-07-19T10:00:00+05:30";
const SESSION_ID = "S-20260719-local";
const CONVERSATION_ID = "S-20260719-local-C-000001";
const RUN_ID = "R-20260719-0001";
const WORKSTREAM_ID = "W-20260719-0001";
const RESOURCE_ID = "RES-1234567890ABCDEF12345678";

describe("Git Context protocol 36 contracts", () => {
  it("exposes the current workstream and resource protocol", () => {
    expect(GIT_CONTEXT_PROTOCOL_VERSION).toBe(36);
    expect(isRequestEnvelope({ requestId: "REQ-1" })).toBe(true);
    expect(isRequestEnvelope({ requestId: " " })).toBe(false);
  });

  it("validates session bootstrap and atomic turn preparation with resources", () => {
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
      content: "Inspect the referenced directory.",
      resources: [{
        admissionId: "attachment-1",
        kind: "directory",
        origin: "user_reference",
        locator: { kind: "filesystem", path: "/tmp/example" },
        displayName: "example",
        description: "Directory referenced by the user.",
        aliases: ["example project"],
        role: "reference",
      }],
      at: AT,
    })).toBe(true);
    expect(isPrepareContextTurnRequest({
      requestId: "REQ-turn",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "assistant",
      content: "Invalid ingress role.",
      at: AT,
    })).toBe(false);
  });

  it("creates a workstream on the existing run without project placement fields", () => {
    const valid = {
      requestId: "REQ-create-workstream",
      sessionId: SESSION_ID,
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      title: "Coffee Shop Website",
      objective: "Build and verify a responsive coffee-shop website.",
      resources: [{
        resourceId: RESOURCE_ID,
        role: "primary" as const,
        access: "mutate" as const,
        primary: true,
      }],
      at: AT,
    };
    expect(isCreateWorkstreamForRunRequest(valid)).toBe(true);
    expect(isCreateWorkstreamForRunRequest({ ...valid, runId: undefined })).toBe(false);
    expect(isCreateWorkstreamForRunRequest({ ...valid, placement: { mode: "managed" } })).toBe(false);
  });

  it("requires an explicit continue-or-create decision when activating a workstream", () => {
    const base = {
      requestId: "REQ-activate-workstream",
      sessionId: SESSION_ID,
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      workstreamId: WORKSTREAM_ID,
      expectedWorkstreamHead: "a".repeat(40),
      at: AT,
    };
    expect(isActivateWorkstreamForRunRequest(base)).toBe(false);
    expect(isActivateWorkstreamForRunRequest({
      ...base,
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "Continue the same unfinished outcome.",
      },
    })).toBe(true);
    expect(isActivateWorkstreamForRunRequest({
      ...base,
      route: {
        kind: "create_active_request",
        reason: "Start a distinct bounded outcome.",
        title: "Add a lesson",
        request: "Add and verify the next lesson.",
        acceptance: ["The lesson is verified."],
        constraints: [],
      },
    })).toBe(true);
  });

  it("validates request-route planning, resource inspection, and binding", () => {
    expect(isPlanWorkstreamRequestRouteRequest({
      requestId: "REQ-route",
      sessionId: SESSION_ID,
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      workstreamId: WORKSTREAM_ID,
      expectedWorkstreamHead: "a".repeat(40),
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "Continue the current request.",
      },
      at: AT,
    })).toBe(true);
    expect(isInspectResourceForRunRequest({
      requestId: "REQ-inspect",
      sessionId: SESSION_ID,
      runId: RUN_ID,
      locator: { kind: "url", url: "https://example.com/reference" },
      kind: "url",
      origin: "agent_discovered",
      description: "Primary reference page.",
      aliases: ["reference page"],
      at: AT,
    })).toBe(true);
    expect(isBindResourcesForRunRequest({
      requestId: "REQ-bind",
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workstreamId: WORKSTREAM_ID,
      bindings: [{ resourceId: RESOURCE_ID, role: "reference", access: "read" }],
      at: AT,
    })).toBe(true);
  });

  it("validates exact resource mutation preparation and verification", () => {
    expect(isPrepareResourceMutationRequest({
      requestId: "REQ-prepare-mutation",
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workstreamId: WORKSTREAM_ID,
      activeRequestId: "R-0001",
      callId: "call-write-1",
      tool: "write_files",
      effect: "workspace_mutation",
      targets: [{
        resourceId: RESOURCE_ID,
        relativePath: "index.html",
        kind: "file",
        expectedVersionKey: "directory:before",
      }],
      at: AT,
    })).toBe(true);
    expect(isPrepareResourceMutationRequest({
      requestId: "REQ-prepare-mutation",
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workstreamId: WORKSTREAM_ID,
      activeRequestId: "R-0001",
      callId: "call-write-1",
      tool: "write_files",
      effect: "workspace_mutation",
      targets: [],
      at: AT,
    })).toBe(false);
    expect(isVerifyResourceMutationRequest({
      requestId: "REQ-verify-mutation",
      operationId: "RM-123",
      leaseId: "RL-123",
      lockToken: "secret-token",
      toolStatus: "completed",
      at: AT,
    })).toBe(true);
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
        input: { paths: ["/tmp/example/src/app.ts"] },
        output: { files: ["/tmp/example/src/app.ts"] },
      }],
      verification: { passed: true },
      workStateAfter: workState(),
      createdAt: AT,
    };
    expect(isRecordRunStepRequest({
      requestId: "REQ-step",
      sessionId: SESSION_ID,
      runId: RUN_ID,
      record,
    })).toBe(true);
    expect(isRecordRunStepRequest({
      requestId: "REQ-step-invalid",
      sessionId: SESSION_ID,
      runId: RUN_ID,
      record: { ...record, toolCalls: [{ ...record.toolCalls[0], toolEffect: "unknown" }] },
    })).toBe(false);
  });

  it("enforces truthful terminal pairs and resource-shaped completion evidence", () => {
    const base = finalization();
    expect(isFinalizeRunRequest(base)).toBe(true);
    expect(isFinalizeRunRequest({ ...base, outcome: "done", stopReason: "run_limit" })).toBe(false);
    const completion = {
      accepted: true,
      resources: [{
        resourceId: RESOURCE_ID,
        kind: "directory" as const,
        role: "deliverable" as const,
        description: "Verified website output.",
        aliases: ["website"],
        verified: true,
      }],
      missing: [],
      failures: [],
      criteria: [{ criterion: "The requested result is verified.", passed: true }],
    };
    expect(isFinalizeRunRequest({ ...base, workstream: { completion } })).toBe(true);
    expect(isFinalizeRunRequest({
      ...base,
      workstream: { completion: { ...completion, accepted: false } },
    })).toBe(false);
    expect(isFinalizeRunRequest({
      ...base,
      outcome: "failed",
      stopReason: "failed",
      validation: "failed",
      workState: { ...workState(), status: "not_done" },
      workstream: { completion: { ...completion, accepted: false } },
    })).toBe(true);
  });

  it("publishes and validates the durable finalization text boundaries", () => {
    const base = finalization();
    const contextBoundary = "x".repeat(
      RUN_FINALIZATION_LIMITS.workState.contextItemChars,
    );
    expect(isFinalizeRunRequest({
      ...base,
      next: "n".repeat(RUN_FINALIZATION_LIMITS.nextChars),
      workState: {
        ...base.workState,
        blockers: [contextBoundary],
        userInputNeeded: [contextBoundary],
        nextStep: "n".repeat(RUN_FINALIZATION_LIMITS.workState.nextStepChars),
      },
    })).toBe(true);
    expect(isFinalizeRunRequest({
      ...base,
      workState: {
        ...base.workState,
        userInputNeeded: [contextBoundary + "x"],
      },
    })).toBe(false);
    expect(isFinalizeRunRequest({
      ...base,
      next: "n".repeat(RUN_FINALIZATION_LIMITS.nextChars + 1),
    })).toBe(false);
  });

  it("serializes structured service errors", () => {
    const error = new GitContextServiceError({
      code: "WORKSTREAM_LOCKED",
      message: "Workstream is already owned.",
      retryable: true,
      details: { workstreamId: WORKSTREAM_ID },
    });
    expect(isGitContextErrorResponse(error.toResponse())).toBe(true);
    expect(error.toResponse().error).toMatchObject({
      code: "WORKSTREAM_LOCKED",
      retryable: true,
      details: { workstreamId: WORKSTREAM_ID },
    });
  });
});

function finalization(): FinalizeRunRequest {
  return {
    requestId: "REQ-finalize",
    sessionId: SESSION_ID,
    runId: RUN_ID,
    outcome: "done",
    stopReason: "completed",
    assistantResponse: "The requested result is complete.",
    conversationSummary: "The user requested and received a verified result.",
    summary: "The requested result is complete.",
    validation: "passed",
    workState: { ...workState(), status: "done" },
    at: AT,
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
