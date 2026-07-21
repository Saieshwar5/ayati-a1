import { describe, expect, it } from "vitest";
import type { ContextCheckpointRecord, StreamMessage } from "ayati-context-engine";
import { buildAgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import type { LoopState } from "../../src/ivec/types.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

const AT = "2026-07-19T10:00:00.000Z";

describe("buildAgentStateView", () => {
  it("projects the V6 temporal, current, stream, work, resource, and observation lanes", () => {
    const context = createContext();
    context.agentStream.recentWork = [{
      workstreamId: "W-20260718-0001",
      requestId: "R-0001",
      outcome: "done",
      resourceIds: ["RES-0123456789ABCDEF01234567"],
      completedAt: "2026-07-18T10:00:00.000Z",
    }];
    context.workstreamCandidates = [{
      workstreamId: "W-20260718-0001",
      title: "Earlier work",
      objective: "Keep earlier work discoverable.",
      status: "active",
      head: "0123456789abcdef",
      primaryResources: [],
      updatedAt: "2026-07-18T10:00:00.000Z",
      discovery: { tier: "candidate", reasons: ["text_match"] },
      starred: false,
      boundRunsLast30Days: 1,
    }];
    context.observations = evidenceObservations();

    const view = buildAgentStateView(createLoopState({ context }));

    expect(view.context.temporal.recent).toEqual([
      expect.objectContaining({ kind: "user", seq: 1, content: "Current request", current: true }),
    ]);
    expect(view.context.current).toMatchObject({
      inputSeq: 1,
      runId: "RUN-1",
      routing: { status: "unbound" },
    });
    expect(view.context.current).not.toHaveProperty("input");
    expect(JSON.stringify(view.context).match(/Current request/g)).toHaveLength(1);
    expect(view.context.stream).toMatchObject({
      agentId: "local",
      scopeKey: "default",
      recentWork: [{ workstreamId: "W-20260718-0001", outcome: "done" }],
    });
    expect(view.context.work.candidates).toHaveLength(1);
    expect(view.context.observations.evidence).toEqual([
      expect.objectContaining({ observationId: "OBS-1", preview: "Verified source text" }),
    ]);
    expect(view.context).not.toHaveProperty("git");
    expect(view.context).not.toHaveProperty("session");
    expect(view).not.toHaveProperty("timeline");
  });

  it("projects only model-facing checkpoint fields while preserving exact anchors", () => {
    const context = createContext();
    context.agentStream.checkpoint = checkpoint();

    const projected = buildAgentStateView(createLoopState({ context })).context.temporal.checkpoint;

    expect(projected).toMatchObject({
      coveredFromSeq: 1,
      coveredToSeq: 4,
      exactAnchors: [1, 3],
      summary: { narrative: "The user requested a durable context redesign." },
      createdAt: AT,
    });
    expect(projected).not.toHaveProperty("checkpointId");
    expect(projected).not.toHaveProperty("sourceHash");
    expect(projected).not.toHaveProperty("provider");
    expect(projected).not.toHaveProperty("model");
  });

  it("keeps active workstream context and resources separate from slow stream continuity", () => {
    const context = createBoundContext();

    const view = buildAgentStateView(createLoopState({ context }));

    expect(view.context.work.active).toMatchObject({
      workstreamId: "W-20260719-0001",
      currentRequest: { id: "R-0001", status: "active" },
    });
    expect(view.context.resources.activeWorkstream).toEqual([
      expect.objectContaining({
        resource: expect.objectContaining({
          resourceId: "RES-0123456789ABCDEF01234567",
          locator: { kind: "filesystem", path: "/tmp/ayati-project" },
        }),
      }),
    ]);
    expect(view.context.stream.recentWork).toEqual([]);
  });

  it("groups personal memory, tool state, harness feedback, and fast run state into distinct lanes", () => {
    const state = createLoopState({
      context: createContext(),
      personalMemorySnapshot: "The user prefers compact architecture notes.",
    });
    state.workState = {
      status: "not_done",
      summary: "Inspecting the context architecture.",
      openWork: ["Verify checkpoint behavior."],
      blockers: [],
      verifiedFacts: ["The agent stream is durable."],
      evidence: ["history:message:1"],
      nextStep: "Run focused tests.",
    };
    state.toolContext = {
      recent: [],
      toolCalls: [{
        step: 1,
        callId: "read-1",
        tool: "read_files",
        purpose: "Inspect the implementation.",
        input: { files: [{ path: "context-pack.ts" }] },
        status: "success",
        output: "export function buildAgentContextPack() {}",
      }],
    };
    state.lastToolLoad = {
      status: "partial",
      requested: { toolNames: ["read_files", "missing_tool"], groups: [] },
      loaded: ["read_files"],
      alreadyActive: [],
      evicted: [],
      missing: ["missing_tool"],
      unavailable: [],
      message: "Loaded read_files; missing_tool was unavailable.",
    };

    const view = buildAgentStateView(state, { activeTools: ["read_files", "read_files"] });

    expect(view.context.personal).toEqual({
      memorySnapshot: "The user prefers compact architecture notes.",
    });
    expect(view.context.tools).toMatchObject({
      active: ["read_files"],
      lastLoad: { status: "partial", missing: ["missing_tool"] },
    });
    expect(view.context.harness).toMatchObject({
      feedback: { latest: expect.arrayContaining([expect.objectContaining({ source: "tool_load" })]) },
    });
    expect(view.context.run).toMatchObject({
      workState: { status: "not_done", nextStep: "Run focused tests." },
      toolCalls: [expect.objectContaining({ tool: "read_files", callId: "read-1" })],
    });
    expect(view.context.stream).not.toHaveProperty("toolCalls");
    expect(view.context.observations).not.toHaveProperty("toolCalls");
  });

  it("uses immutable message identity when repeated user text appears", () => {
    const context = createContext();
    context.agentStream.recentMessages = [
      streamMessage({ messageId: "M-1", sequence: 1, content: "continue" }),
      streamMessage({ messageId: "M-2", sequence: 2, content: "continue" }),
    ];
    context.agentStream.meta.lastMessageSequence = 2;
    const state = createLoopState({ context, message: "continue" });
    state.currentMessageId = "M-2";
    state.currentSeq = 2;

    const recent = buildAgentStateView(state).context.temporal.recent;

    expect(recent.filter((event) => event.current)).toEqual([
      expect.objectContaining({ seq: 2, content: "continue", current: true }),
    ]);
    expect(recent[0]).toEqual(expect.objectContaining({ seq: 1, content: "continue" }));
    expect(recent[0]).not.toHaveProperty("current");
  });

  it("fails closed when the prepared stream does not contain the declared current message", () => {
    const state = createLoopState({ context: createContext() });
    state.currentMessageId = "M-missing";

    expect(() => buildAgentStateView(state)).toThrow("CURRENT_INPUT_CONTEXT_MISMATCH");
  });

  it("synthesizes one exact current input when durable context is unavailable", () => {
    const state = createLoopState({ context: undefined, message: "  Keep this text exact.  " });
    state.currentSeq = 7;

    const view = buildAgentStateView(state);

    expect(view.context.temporal.recent).toEqual([{
      kind: "user",
      seq: 7,
      timestamp: new Date(0).toISOString(),
      content: "  Keep this text exact.  ",
      current: true,
    }]);
    expect(view.context.current).toMatchObject({ inputSeq: 7, runId: "RUN-1" });
  });

  it("projects system events into the temporal lane without treating them as user messages", () => {
    const state = createLoopState({ context: undefined, message: "Meeting started." });
    state.inputKind = "system_event";
    state.systemEvent = {
      type: "system_event",
      eventId: "EVT-1",
      source: "calendar",
      eventName: "meeting.started",
      receivedAt: AT,
      summary: "Meeting started.",
      payload: {},
    };

    const view = buildAgentStateView(state);

    expect(view.context.temporal.recent).toEqual([
      expect.objectContaining({
        kind: "system_event",
        source: "calendar",
        event: "meeting.started",
        summary: "Meeting started.",
        current: true,
      }),
    ]);
    expect(view.systemEvent).toMatchObject({ source: "calendar", eventName: "meeting.started" });
  });

  it("reports pressure escalation as a stream checkpoint recommendation", () => {
    const state = createLoopState({ context: createContext() });
    state.contextPressure = {
      mode: "tool_compact",
      recommendedMode: "stream_checkpoint",
      escalationReason: "repeated_unresolved_pressure",
      softLimitBreachCount: 2,
      unresolvedPressureStreak: 2,
      successfulRecoveryCount: 0,
      admissionRejectionCount: 0,
      peakCandidateInputTokens: 84_000,
    };

    expect(buildAgentStateView(state).context.run?.contextPressure).toEqual({
      mode: "tool_compact",
      recommendedMode: "stream_checkpoint",
      escalationReason: "repeated_unresolved_pressure",
      unresolvedPressureStreak: 2,
      compactedCalls: 0,
      recoverable: true,
    });
  });
});

function createContext(): ContextEngineMachineContext {
  return contextEngineFixture({ runId: "RUN-1", message: "Current request" });
}

function createBoundContext(): ContextEngineMachineContext {
  const context = createContext();
  context.current.routing = {
    status: "bound",
    workstreamId: "W-20260719-0001",
    requestId: "R-0001",
    branch: "work/W-20260719-0001",
  };
  context.focus = {
    status: "active",
    ref: "refs/heads/work/W-20260719-0001",
    workstreamId: "W-20260719-0001",
  };
  context.workstream = {
    ref: "refs/heads/work/W-20260719-0001",
    workstreamId: "W-20260719-0001",
    title: "Agent context redesign",
    objective: "Separate stream continuity from run execution state.",
    summary: "The V6 context lanes are implemented.",
    workstreamStatus: "in_progress",
    lifecycleStatus: "active",
    repositoryHealth: "ready",
    blockers: [],
    next: "Verify the design.",
    currentRequest: {
      id: "R-0001",
      title: "Implement V6 context",
      status: "active",
      request: "Implement the approved context plan.",
      acceptance: ["Stream and run context are separate."],
      constraints: [],
    },
    resources: [workstreamResource()],
  };
  return context;
}

function createLoopState(input: {
  context?: ContextEngineMachineContext;
  message?: string;
  personalMemorySnapshot?: string;
}): LoopState {
  const message = input.message ?? "Current request";
  return {
    runId: "RUN-1",
    currentSeq: 1,
    currentMessageId: input.context ? "M-1" : undefined,
    inputKind: "user_message",
    userMessage: message,
    workState: {
      status: "not_done",
      summary: "",
      openWork: [],
      blockers: [],
      verifiedFacts: [],
      evidence: [],
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 20,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "/tmp/ayati/RUN-1",
    failureHistory: [],
    harnessContext: {
      personalMemorySnapshot: input.personalMemorySnapshot ?? "",
      ...(input.context ? { contextEngine: input.context } : {}),
    },
  };
}

function streamMessage(input: {
  messageId: string;
  sequence: number;
  content: string;
}): StreamMessage {
  return {
    messageId: input.messageId,
    streamId: "S-1",
    runId: "RUN-1",
    sequence: input.sequence,
    role: "user",
    content: input.content,
    contentHash: `sha256:${input.messageId}`,
    at: `2026-07-19T10:00:0${input.sequence}.000Z`,
  };
}

function checkpoint(): ContextCheckpointRecord {
  return {
    checkpointId: "CHK-1",
    streamId: "S-1",
    coveredFromSeq: 1,
    coveredToSeq: 4,
    sourceHash: "sha256:source",
    schemaVersion: 1,
    summary: {
      userRequests: [{ seq: 1, text: "Redesign the context architecture." }],
      constraints: [],
      decisions: [{ seq: 3, text: "Separate agent-stream and run context." }],
      corrections: [],
      importantFacts: [],
      unresolvedQuestions: [],
      references: [],
      narrative: "The user requested a durable context redesign.",
    },
    exactAnchors: [1, 3],
    tokenCount: 120,
    reason: "context_pressure",
    provider: "test-provider",
    model: "test-model",
    createdAt: AT,
  };
}

function evidenceObservations(): ContextEngineMachineContext["observations"] {
  return {
    revision: "observations:1",
    inventory: [],
    discovery: [],
    evidence: [{
      observationId: "OBS-1",
      streamId: "S-1",
      sourceRunId: "RUN-1",
      sourceStep: 1,
      sourceCallId: "read-1",
      kind: "evidence",
      queryKey: "read_files:context-pack",
      purpose: "Inspect context projection.",
      preview: "Verified source text",
      evidenceRef: "history:run:RUN-1:step:1",
      retention: "evidence_only",
      resources: [],
      createdAt: AT,
    }],
  };
}

function workstreamResource() {
  return {
    resource: {
      resourceId: "RES-0123456789ABCDEF01234567",
      kind: "directory" as const,
      origin: "agent_created" as const,
      displayName: "Ayati project",
      description: "Repository containing the implementation.",
      aliases: ["ayati"],
      locator: { kind: "filesystem" as const, path: "/tmp/ayati-project" },
      version: {
        key: "directory:v1",
        observedAt: AT,
        exists: true,
        kind: "directory" as const,
        entryCount: 10,
      },
      availability: "available" as const,
      metadataStatus: "enriched" as const,
      createdAt: AT,
      updatedAt: AT,
    },
    role: "primary" as const,
    access: "mutate" as const,
    primary: true,
    requestIds: ["R-0001"],
    boundAt: AT,
  };
}
