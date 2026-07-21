import { describe, expect, it } from "vitest";
import {
  isActivateWorkstreamForRunRequest,
  isCommitContextCheckpointRequest,
  isCreateWorkstreamForRunRequest,
  isFinalizeRunRequest,
  isPlanContextCheckpointRequest,
  isPrepareAgentRunRequest,
  isReadAgentHistoryRequest,
  isRecordRunStepRequest,
  isRequestEnvelope,
  isSearchAgentHistoryRequest,
  type ContextCheckpointPlan,
  type ContextCheckpointSummary,
  type FinalizeRunRequest,
  type RunStepRecord,
  type RunWorkStateInput,
} from "../src/contracts.js";
import { ContextEngineServiceError } from "../src/errors.js";

const AT = "2026-07-20T10:00:00+05:30";
const RUN_ID = "RUN-EXAMPLE-0001";
const STREAM_ID = "AS-1234567890ABCDEF12345678";
const WORKSTREAM_ID = "W-20260720-0001";

describe("Context Engine contracts", () => {
  it("validates request envelopes", () => {
    expect(isRequestEnvelope({ requestId: "REQ-1" })).toBe(true);
    expect(isRequestEnvelope({ requestId: " " })).toBe(false);
    expect(isRequestEnvelope({ requestId: "REQ-1", expectedHead: "legacy" })).toBe(false);
  });

  it("validates atomic agent-run preparation without session fields", () => {
    const valid = {
      requestId: "REQ-turn",
      timezone: "Asia/Kolkata",
      agentId: "local",
      scopeKey: "default",
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
    };
    expect(isPrepareAgentRunRequest(valid)).toBe(true);
    expect(isPrepareAgentRunRequest({ ...valid, role: "assistant" })).toBe(false);
    expect(isPrepareAgentRunRequest({ ...valid, date: "2026-07-20" })).toBe(false);
  });

  it("creates and activates workstreams on the existing run", () => {
    expect(isCreateWorkstreamForRunRequest({
      requestId: "REQ-create",
      runId: RUN_ID,
      title: "Coffee Shop Website",
      objective: "Build and verify a responsive website.",
      at: AT,
    })).toBe(true);
    expect(isActivateWorkstreamForRunRequest({
      requestId: "REQ-activate",
      runId: RUN_ID,
      workstreamId: WORKSTREAM_ID,
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "Continue the same unfinished outcome.",
      },
      at: AT,
    })).toBe(true);
  });

  it("validates list/search/read steps and rejects inconsistent effects", () => {
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
    expect(isRecordRunStepRequest({ requestId: "REQ-step", runId: RUN_ID, record })).toBe(true);
    expect(isRecordRunStepRequest({
      requestId: "REQ-step-invalid",
      runId: RUN_ID,
      record: {
        ...record,
        toolCalls: [{ ...record.toolCalls[0], toolPurpose: "read", toolEffect: "workspace_mutation" }],
      },
    })).toBe(false);
  });

  it("validates pressure checkpoint planning and anchored commits", () => {
    expect(isPlanContextCheckpointRequest({
      requestId: "REQ-plan",
      streamId: STREAM_ID,
      protectFromSeq: 9,
      requiredSavingsTokens: 1_000,
      estimatedCheckpointTokens: 1_200,
      at: AT,
    })).toBe(true);
    expect(isPlanContextCheckpointRequest({
      requestId: "REQ-plan",
      streamId: STREAM_ID,
      protectFromSeq: 0,
      requiredSavingsTokens: 1_000,
      at: AT,
    })).toBe(false);

    const plan = checkpointPlan();
    expect(isCommitContextCheckpointRequest({
      requestId: "REQ-commit",
      plan,
      summary: checkpointSummary(),
      tokenCount: 120,
      provider: "test",
      model: "test-v1",
      at: AT,
    })).toBe(true);
  });

  it("validates bounded history search and exact read modes", () => {
    expect(isSearchAgentHistoryRequest({
      streamId: STREAM_ID,
      query: "earlier decision",
      kinds: ["message", "run", "evidence"],
      limit: 25,
    })).toBe(true);
    expect(isSearchAgentHistoryRequest({ streamId: STREAM_ID, query: "x", limit: 26 })).toBe(false);
    expect(isReadAgentHistoryRequest({ streamId: STREAM_ID, ref: "seq:4", maxChars: 32_000 })).toBe(true);
    expect(isReadAgentHistoryRequest({ streamId: STREAM_ID, fromSeq: 2, toSeq: 8 })).toBe(true);
    expect(isReadAgentHistoryRequest({ streamId: STREAM_ID, fromSeq: 8, toSeq: 2 })).toBe(false);
    expect(isReadAgentHistoryRequest({ streamId: STREAM_ID, ref: "seq:4", fromSeq: 4, toSeq: 4 })).toBe(false);
  });

  it("enforces truthful terminal pairs", () => {
    const base = finalization();
    expect(isFinalizeRunRequest(base)).toBe(true);
    expect(isFinalizeRunRequest({ ...base, outcome: "done", stopReason: "run_limit" })).toBe(false);
    expect(isFinalizeRunRequest({ ...base, streamSummary: "" })).toBe(false);
  });

  it("exposes typed service errors directly", () => {
    const error = new ContextEngineServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Run is not active.",
      retryable: false,
      details: { runId: RUN_ID },
    });
    expect(error).toMatchObject({
      name: "ContextEngineServiceError",
      code: "RUN_NOT_ACTIVE",
      message: "Run is not active.",
      retryable: false,
      details: { runId: RUN_ID },
    });
  });
});

function checkpointPlan(): ContextCheckpointPlan {
  return {
    planId: "CPPLAN-1234567890ABCDEF12345678",
    streamId: STREAM_ID,
    selectedMessages: [{
      messageId: "MSG-1",
      streamId: STREAM_ID,
      runId: RUN_ID,
      sequence: 1,
      role: "user",
      content: "Remember the exact request.",
      contentHash: "hash",
      at: AT,
    }],
    exactTail: [],
    coveredFromSeq: 1,
    coveredToSeq: 1,
    sourceHash: "source-hash",
    estimatedCheckpointTokens: 1_200,
    triggered: true,
  };
}

function checkpointSummary(): ContextCheckpointSummary {
  return {
    userRequests: [{ seq: 1, text: "Remember the exact request." }],
    constraints: [],
    decisions: [],
    corrections: [],
    importantFacts: [],
    unresolvedQuestions: [],
    references: [],
    narrative: "The user made one exact request.",
  };
}

function finalization(): FinalizeRunRequest {
  return {
    requestId: "REQ-finalize",
    runId: RUN_ID,
    outcome: "done",
    stopReason: "completed",
    assistantResponse: "The requested response is complete.",
    streamSummary: "The exchange completed.",
    summary: "Completed the request.",
    validation: "not_applicable",
    workState: workState({ status: "done", summary: "Completed the request." }),
    at: AT,
  };
}

function workState(overrides: Partial<RunWorkStateInput> = {}): RunWorkStateInput {
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
    ...overrides,
  };
}
