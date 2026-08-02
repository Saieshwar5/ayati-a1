import { describe, expect, it } from "vitest";
import type { ContextCheckpointRecord, StreamMessage } from "ayati-context-engine";
import { projectAgentStateViewForPrompt } from "../../src/ivec/agent-runner/prompt-context.js";
import { buildAgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import type { LoopState } from "../../src/ivec/types.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

const AT = "2026-07-19T10:00:00.000Z";

describe("buildAgentStateView", () => {
  it("projects the exact configured workspace root once as run navigation context", () => {
    const workspaceRoot = "/opt/ayati/runtime/workspace";
    const context = createContext();
    context.workstreamRepository = {
      path: "/opt/ayati/runtime/workstreams",
      branch: "main",
      head: "0123456789abcdef0123456789abcdef01234567",
      health: "ready",
      kind: "context_only_git",
      access: "read_only",
    };
    const view = buildAgentStateView(createLoopState({ context }), {
      workspaceRoot,
    });
    const prompt = projectAgentStateViewForPrompt(view);

    expect(view.context.run?.workspaceRoot).toBe(workspaceRoot);
    expect(prompt.context.run?.workspaceRoot).toBe(workspaceRoot);
    expect(JSON.stringify(prompt).match(/\/opt\/ayati\/runtime\/workspace/g)).toHaveLength(1);
    expect(prompt.context.run?.workstreamRepository).toEqual(context.workstreamRepository);
    expect(JSON.stringify(prompt).match(/\/opt\/ayati\/runtime\/workstreams/g)).toHaveLength(1);
    expect(prompt.context.core.current).not.toHaveProperty("workspaceRoot");
    expect(prompt.context.run?.workState).toBeUndefined();
    expect(prompt.context.run?.boundWorkstream).toBeUndefined();
  });

  it("projects the Core Capsule without always-present work or resource lanes", () => {
    const context = createContext();
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
    const view = buildAgentStateView(createLoopState({ context }));

    expect(view.context.core.current).toMatchObject({
      runId: "RUN-1",
      input: { kind: "user", seq: 1, content: "Current request", current: true },
      routing: { status: "unbound" },
    });
    expect(JSON.stringify(view.context).match(/Current request/g)).toHaveLength(1);
    expect(view.context).not.toHaveProperty("work");
    expect(view.context).not.toHaveProperty("resources");
    expect(view.context).not.toHaveProperty("observations");
    expect(context.workstreamCandidates).toHaveLength(1);
    expect(view.context).not.toHaveProperty("git");
    expect(view.context).not.toHaveProperty("session");
    expect(view).not.toHaveProperty("timeline");
  });

  it("projects only model-facing checkpoint fields while preserving exact anchors", () => {
    const context = createContext();
    context.agentStream.checkpoint = checkpoint();

    const projected = buildAgentStateView(createLoopState({ context }))
      .context.core.continuity.checkpoint;

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

  it("always projects only the five newest recent-document navigation pointers", () => {
    const context = createContext();
    context.agentStream.recentFiles = Array.from({ length: 6 }, (_, index) => ({
      name: `document-${index + 1}.txt`,
      path: `/workspace/document-${index + 1}.txt`,
      lastReadAt: `2026-07-19T09:0${index}:00.000Z`,
      evidenceRef: `run:RUN-${index + 1}:step:1:call:read`,
      coverage: "complete" as const,
      status: "navigation_only" as const,
      sizeBytes: 1_000 + index,
      lineCount: 20 + index,
      sha256: `sha256-${index + 1}`,
    }));

    const activeDocuments = buildAgentStateView(
      createLoopState({ context }),
    ).context.core.current.activeDocuments;

    expect(activeDocuments).toHaveLength(5);
    expect(activeDocuments?.map((document) => document.path)).toEqual([
      "/workspace/document-1.txt",
      "/workspace/document-2.txt",
      "/workspace/document-3.txt",
      "/workspace/document-4.txt",
      "/workspace/document-5.txt",
    ]);
    expect(activeDocuments?.[0]).toMatchObject({
      evidenceRef: "run:RUN-1:step:1:call:read",
      freshness: "unchecked",
    });
    expect(activeDocuments?.[0]).not.toHaveProperty("sha256");
    expect(JSON.stringify(activeDocuments)).not.toContain("document-6.txt");
  });

  it("projects the bound request contract and bounded resource metadata once", () => {
    const context = createBoundContext();
    const state = createLoopState({ context });

    const view = buildAgentStateView(state);
    const prompt = projectAgentStateViewForPrompt(view);

    expect(view.context).not.toHaveProperty("work");
    expect(view.context).not.toHaveProperty("resources");
    expect(view.context.run).not.toHaveProperty("workState");
    expect(prompt.context.run?.boundWorkstream).toEqual({
      id: "W-20260719-0001",
      title: "Agent context redesign",
      purpose: "Separate stream continuity from run execution state.",
      summary: "The V6 context lanes are implemented.",
      lifecycleStatus: "active",
      blockers: [],
      nextAction: "Verify the design.",
      request: {
        id: "R-0001",
        title: "Implement V6 context",
        status: "active",
        request: "Implement the approved context plan.",
        acceptance: ["Stream and run context are separate."],
        constraints: [],
        lifecycleNote: "Continue the selected request.",
      },
      recentProgress: [{
        runId: "RUN-EARLIER",
        outcome: "incomplete",
        summary: "Implemented the context lanes.",
        validation: "Runtime wiring remains.",
        next: "Wire the prompt projection.",
      }],
      resources: [{
        id: "RES-0123456789ABCDEF01234567",
        name: "Ayati project",
        kind: "directory",
        description: "Repository containing the implementation.",
        aliases: ["ayati"],
        locator: {
          kind: "filesystem",
          path: "/tmp/ayati-project",
        },
        role: "primary",
        access: "mutate",
        availability: "available",
        primary: true,
        requestRelevant: true,
      }],
      otherResourceCount: 0,
    });
    expect(context.workstream).toMatchObject({
      workstreamId: "W-20260719-0001",
      currentRequest: { id: "R-0001", status: "active" },
    });
    expect(context.workstream?.resources[0]?.resource.locator).toEqual({
      kind: "filesystem",
      path: "/tmp/ayati-project",
    });
    expect(JSON.stringify(prompt).match(/\/tmp\/ayati-project/g)).toHaveLength(1);

    state.workState = {
      status: "in_progress",
      summary: "The contract is complete and runtime wiring remains.",
      plan: [{
        id: "runtime",
        task: "Wire the runtime.",
        status: "active",
      }],
      importantContext: [],
      nextAction: "Wire the runtime.",
    };
    state.workStateRuntime = {
      revision: 1,
      afterStep: 0,
      updateReason: "plan",
    };
    const materialPrompt = projectAgentStateViewForPrompt(
      buildAgentStateView(state),
    );
    expect(materialPrompt.context.run?.workState).toMatchObject({
      status: "in_progress",
      summary: "The contract is complete and runtime wiring remains.",
      nextAction: "Wire the runtime.",
    });
    expect(materialPrompt.context.run?.workState)
      .not.toHaveProperty("activeWorkstream");
    expect(materialPrompt.context.run?.boundWorkstream?.request.id)
      .toBe("R-0001");
  });

  it("keeps selected and active request identities only in boundWorkstream", () => {
    const context = createBoundContext();
    context.current.routing = {
      status: "bound",
      workstreamId: "W-20260719-0001",
      requestId: "R-0002",
      branch: "work/W-20260719-0001",
    };
    context.workstream!.selectedRequest = {
      id: "R-0002",
      title: "Validate the runtime",
      status: "queued",
      request: "Validate the context runtime.",
      acceptance: ["The runtime tests pass."],
      constraints: [],
      lifecycleNote: "Selected for this run.",
    };
    const state = createLoopState({ context });
    state.workState = {
      status: "in_progress",
      summary: "Preparing runtime validation.",
      plan: [],
      importantContext: [],
      nextAction: "Run the focused tests.",
    };
    state.workStateRuntime = {
      revision: 1,
      afterStep: 0,
      updateReason: "continuation",
    };

    const prompt = projectAgentStateViewForPrompt(buildAgentStateView(state));

    expect(prompt.context.run?.boundWorkstream).toMatchObject({
      request: { id: "R-0002", status: "queued" },
      activeRequest: { id: "R-0001", status: "active" },
    });
    expect(prompt.context.run?.workState)
      .not.toHaveProperty("activeWorkstream");
    expect(JSON.stringify(prompt.context.run?.workState)).not.toContain(
      "R-0001",
    );
    expect(JSON.stringify(prompt.context.run?.workState)).not.toContain(
      "R-0002",
    );
  });

  it("groups loaded Hot Context, tool state, harness feedback, and fast run state into distinct lanes", () => {
    const state = createLoopState({
      context: createContext(),
      hotMemorySnapshot: "The user prefers compact architecture notes.",
    });
    state.workState = {
      status: "in_progress",
      summary: "Inspecting the context architecture.",
      plan: [{
        id: "verify",
        task: "Verify checkpoint behavior.",
        status: "active",
      }],
      importantContext: [{
        kind: "finding",
        value: "The agent stream is durable.",
        ref: "history:message:1",
      }],
      nextAction: "Run focused tests.",
    };
    state.workStateRuntime = {
      revision: 1,
      afterStep: 0,
      updateReason: "plan",
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
        stepRef: {
          runId: "RUN-1",
          step: 1,
          callId: "read-1",
        },
      }],
    };
    state.lastCapabilitySurface = {
      status: "partial",
      requested: ["file:read"],
      capabilities: ["file:read"],
      loaded: ["read_files"],
      alreadyActive: [],
      evicted: [],
      missing: ["missing_tool"],
      unavailable: [],
      unavailableCapabilities: [],
      omittedOptionalTools: [],
      coverage: [],
      message: "Loaded read_files; missing_tool was unavailable.",
    };

    const view = buildAgentStateView(state, { activeTools: ["read_files", "read_files"] });

    expect(view.context.hot).toMatchObject({
      loaded: [{
        key: "personal.memory",
        content: "The user prefers compact architecture notes.",
      }],
      budget: {
        maxMountedTokens: 8_000,
        mountedTokens: 8,
      },
    });
    expect(view.context).not.toHaveProperty("personal");
    expect(view.context.tools).toMatchObject({
      active: ["read_files"],
      lastSurface: { status: "partial", missing: ["missing_tool"] },
    });
    expect(view.context.harness).toMatchObject({
      feedback: { latest: expect.arrayContaining([expect.objectContaining({ source: "capability_surface" })]) },
    });
    expect(view.context.run).toMatchObject({
      workState: { status: "in_progress", nextAction: "Run focused tests." },
      toolCalls: [expect.objectContaining({
        tool: "read_files",
        callId: "read-1",
      })],
    });
    expect(view.context.core).not.toHaveProperty("toolCalls");
    expect(view.context).not.toHaveProperty("observations");
  });

  it("projects current-run evidence once through the run tool-call lane", () => {
    const context = createContext();
    const state = createLoopState({ context });
    state.toolContext = {
      recent: [],
      toolCalls: [{
        step: 1,
        callId: "read-1",
        tool: "read_files",
        purpose: "Inspect the implementation.",
        input: { files: [{ path: "context-pack.ts" }] },
        status: "success",
        output: "Verified source text",
      }],
    };

    const view = buildAgentStateView(state);
    const serialized = JSON.stringify(view.context);

    expect(view.context).not.toHaveProperty("observations");
    expect(view.context.run?.toolCalls).toEqual([
      expect.objectContaining({
        callId: "read-1",
        output: "Verified source text",
      }),
    ]);
    expect(serialized.match(/Verified source text/g)).toHaveLength(1);
  });

  it("keeps exact tool inputs and outputs while projecting only validation-ready proof", () => {
    const state = createLoopState({ context: createContext() });
    const content = "export const generated = true;\n".repeat(800);
    const output = JSON.stringify({
      requested: 1,
      succeeded: 1,
      files: [{ path: "/workspace/src/generated.ts", operation: "created" }],
    });
    state.toolContext = {
      recent: [],
      toolCalls: [{
        step: 2,
        callId: "write-generated",
        tool: "write_files",
        purpose: "Create the generated source file.",
        input: {
          files: [{
            path: "/workspace/src/generated.ts",
            content,
          }],
        },
        status: "success",
        retention: "while_relevant",
        projectionMetadata: { internalHash: "do-not-project" },
        output,
        stepRef: {
          runId: "RUN-1",
          step: 2,
          callId: "write-generated",
        },
        verification: {
          version: 1,
          status: "passed",
          method: "tool_contract",
          contract: "tool_result_v2",
          summary: "The write contract passed.",
          checks: [],
          facts: [],
        },
        verificationPassed: true,
        completionEvidence: [{
          kind: "path_state",
          path: "/workspace/src/generated.ts",
          exists: true,
          actualKind: "file",
          change: "mutated",
          operation: "write",
          tool: "write_files",
          step: 2,
          callId: "write-generated",
        }],
      }],
    };

    const prompt = projectAgentStateViewForPrompt(buildAgentStateView(state));
    const call = prompt.context.run?.toolCalls?.[0];

    expect(call?.input).toEqual({
      files: [{
        path: "/workspace/src/generated.ts",
        content,
      }],
    });
    expect(call?.output).toBe(output);
    expect(call).toMatchObject({
      purpose: "Create the generated source file.",
      status: "success",
      verificationStatus: "passed",
    });
    expect(call).not.toHaveProperty("verification");
    expect(call).not.toHaveProperty("verificationPassed");
    expect(call).not.toHaveProperty("completionEvidence");
    expect(call).not.toHaveProperty("retention");
    expect(call).not.toHaveProperty("projectionMetadata");
    expect(call).not.toHaveProperty("stepRef");
    expect(prompt.context.run?.verifiedOutcomes).toEqual([{
      outcomeRef: "run:RUN-1:step:2:call:write-generated:outcome:0",
      kind: "file.written",
      subject: "/workspace/src/generated.ts",
      actualKind: "file",
      source: {
        step: 2,
        callId: "write-generated",
        tool: "write_files",
      },
    }]);
  });

  it("keeps compact multi-match candidates while hiding internal search metadata", () => {
    const state = createLoopState({ context: createContext() });
    state.toolContext = {
      recent: [],
      toolCalls: [{
        step: 1,
        callId: "find-release-notes",
        tool: "find_files",
        input: {
          query: "release-notes.txt",
          roots: ["/workspace"],
        },
        status: "success",
        output: "Found 2 matches.",
        verificationPassed: true,
        projectionMetadata: {
          query: "release-notes.txt",
          roots: ["/workspace"],
          matches: [
            {
              absolutePath: "/workspace/north/release-notes.txt",
              kind: "file",
            },
            {
              absolutePath: "/workspace/south/release-notes.txt",
              kind: "file",
            },
          ],
          matchCount: 2,
          internalHash: "do-not-project",
        },
      }],
    };

    const call = projectAgentStateViewForPrompt(
      buildAgentStateView(state),
    ).context.run?.toolCalls?.[0];

    expect(call?.candidateSet).toMatchObject({
      matchCount: 2,
      candidates: [
        { label: "north/release-notes.txt" },
        { label: "south/release-notes.txt" },
      ],
    });
    expect(call).not.toHaveProperty("projectionMetadata");
    expect(JSON.stringify(call)).not.toContain("do-not-project");
  });

  it("projects only unresolved repairs while retaining resolved records in run history", () => {
    const state = createLoopState({ context: createContext() });
    state.failureHistory = [{
      step: 1,
      failureType: "validation_error",
      reason: "Old target-provenance repair.",
      blockedTargets: ["/tmp/invented.md"],
      repairCode: "R_MODE_TRANSITION_INVALID",
      repairScope: "navigation",
      resolution: {
        iteration: 3,
        kind: "accepted_mode_transition",
      },
    }, {
      step: 2,
      failureType: "tool_error",
      reason: "Current read repair.",
      blockedTargets: ["/tmp/known.md"],
      repairScope: "action",
    }];

    const view = buildAgentStateView(state);
    const serialized = JSON.stringify(view);

    expect(state.failureHistory).toHaveLength(2);
    expect(serialized).not.toContain("Old target-provenance repair.");
    expect(view.context.harness?.feedback.latest).toEqual([
      expect.objectContaining({ message: "Current read repair." }),
    ]);
    expect(view.trace?.recentFailures).toEqual([
      expect.objectContaining({ reason: "Current read repair." }),
    ]);

    state.failureHistory[1]!.resolution = {
      iteration: 4,
      kind: "verified_action",
    };
    const recoveredView = buildAgentStateView(state);

    expect(recoveredView.context.harness).toBeUndefined();
    expect(recoveredView.workingFeedback).toBeUndefined();
    expect(recoveredView.trace).toBeUndefined();
    expect(state.failureHistory).toHaveLength(2);
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

    const core = buildAgentStateView(state).context.core;

    expect(core.current.input).toEqual(
      expect.objectContaining({ seq: 2, content: "continue", current: true }),
    );
    expect(core.continuity.recentExact).toEqual([
      expect.objectContaining({ seq: 1, content: "continue" }),
    ]);
  });

  it("preserves feedback semantics and attachments on their exact sequence events", () => {
    const context = createContext();
    context.agentStream.recentMessages = [
      streamMessage({ messageId: "M-1", sequence: 1, content: "Prepare the report." }),
      streamMessage({
        messageId: "M-2",
        sequence: 2,
        role: "assistant",
        content: "Should I use the attached source?",
        responseKind: "feedback",
        feedbackKind: "confirmation",
      }),
      streamMessage({
        messageId: "M-3",
        sequence: 3,
        content: "Yes, use this version.",
        attachmentRefs: [{
          resourceId: "RES-0123456789ABCDEF01234567",
          kind: "document",
          displayName: "report-source.md",
        }],
      }),
    ];
    context.agentStream.meta.lastMessageSequence = 3;
    const state = createLoopState({ context, message: "Yes, use this version." });
    state.currentMessageId = "M-3";
    state.currentSeq = 3;

    const core = buildAgentStateView(state).context.core;

    expect(core.continuity.recentExact).toContainEqual(expect.objectContaining({
      kind: "assistant",
      seq: 2,
      responseKind: "feedback",
      feedbackKind: "confirmation",
    }));
    expect(core.current.input).toEqual(expect.objectContaining({
      kind: "user",
      seq: 3,
      attachmentRefs: [{
        resourceId: "RES-0123456789ABCDEF01234567",
        kind: "document",
        displayName: "report-source.md",
      }],
    }));
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

    expect(view.context.core.current.input).toEqual({
      kind: "user",
      seq: 7,
      timestamp: new Date(0).toISOString(),
      content: "  Keep this text exact.  ",
      current: true,
    });
    expect(view.context.core.current).toMatchObject({ runId: "RUN-1" });
  });

  it("projects system events into the Core Capsule without treating them as user messages", () => {
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

    expect(view.context.core.current.input).toEqual(expect.objectContaining({
      kind: "system_event",
      source: "calendar",
      event: "meeting.started",
      summary: "Meeting started.",
      current: true,
    }));
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
    selectedRequest: {
      id: "R-0001",
      title: "Implement V6 context",
      status: "active",
      request: "Implement the approved context plan.",
      acceptance: ["Stream and run context are separate."],
      constraints: [],
      lifecycleNote: "Continue the selected request.",
    },
    recentProgress: [{
      runId: "RUN-EARLIER",
      outcome: "incomplete",
      summary: "Implemented the context lanes.",
      validationSummary: "Runtime wiring remains.",
      nextAction: "Wire the prompt projection.",
      commit: "abc123",
      finalizedAt: "2026-07-19T09:00:00.000Z",
    }],
    resources: [workstreamResource()],
  };
  return context;
}

function createLoopState(input: {
  context?: ContextEngineMachineContext;
  message?: string;
  hotMemorySnapshot?: string;
}): LoopState {
  const message = input.message ?? "Current request";
  return {
    runId: "RUN-1",
    currentSeq: 1,
    currentMessageId: input.context ? "M-1" : undefined,
    inputKind: "user_message",
    userMessage: message,
    workState: {
      status: "in_progress",
      summary: "Run started.",
      plan: [],
      importantContext: [],
    },
    workStateRuntime: {
      revision: 0,
      afterStep: 0,
      updateReason: "initial",
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 20,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "/tmp/ayati/RUN-1",
    failureHistory: [],
    virtualMode: {
      active: null,
      revision: 0,
      operational: false,
      capabilities: [],
      targets: [],
    },
    hotContext: {
      available: [],
      loaded: input.hotMemorySnapshot ? [{
        key: "personal.memory",
        description: "Stable personal facts and preferences learned about the user.",
        version: "test",
        estimatedTokens: 8,
        freshness: "current",
        sourceRefs: ["personal-memory:snapshot"],
        content: input.hotMemorySnapshot,
        mountedAtStep: 1,
      }] : [],
      budget: {
        maxMountedTokens: 8_000,
        mountedTokens: input.hotMemorySnapshot ? 8 : 0,
      },
    },
    harnessContext: {
      ...(input.context ? { contextEngine: input.context } : {}),
    },
  };
}

function streamMessage(input: {
  messageId: string;
  sequence: number;
  content: string;
  role?: StreamMessage["role"];
  responseKind?: StreamMessage["responseKind"];
  feedbackKind?: StreamMessage["feedbackKind"];
  attachmentRefs?: StreamMessage["attachmentRefs"];
}): StreamMessage {
  return {
    messageId: input.messageId,
    streamId: "S-1",
    runId: "RUN-1",
    sequence: input.sequence,
    role: input.role ?? "user",
    content: input.content,
    contentHash: `sha256:${input.messageId}`,
    at: `2026-07-19T10:00:0${input.sequence}.000Z`,
    ...(input.responseKind ? { responseKind: input.responseKind } : {}),
    ...(input.feedbackKind ? { feedbackKind: input.feedbackKind } : {}),
    ...(input.attachmentRefs ? { attachmentRefs: input.attachmentRefs } : {}),
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
