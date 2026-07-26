import type {
  AgentContextProjection,
  CheckpointRunWorkStateResponse,
  ContextCheckpointPlan,
  ContextCheckpointRecord,
  FinalizeRunResponse,
  ContextEngineObservabilityEvent,
  ContextEngineService,
  RecordRunStepResponse,
} from "ayati-context-engine";
import { ContextEngineObserver } from "ayati-context-engine";
import { describe, expect, it, vi } from "vitest";
import { createContextEngineRuntime } from "../../src/app/context-engine-runtime.js";
import { agentContextFixture } from "../fixtures/agent-context.js";

const AT = "2026-07-19T10:00:00.000Z";

describe("Context Engine runtime", () => {
  it("prepares a message and run atomically, then finalizes through the V6 contract", async () => {
    const fixture = serviceFixture();
    const runtime = createContextEngineRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });

    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Explain the context engine.",
      at: AT,
    });
    await runtime.finalizeRun({
      turn,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "The service returns authoritative context.",
      streamSummary: "Explained the context engine.",
      summary: "Answered directly without an action step.",
      validation: "not_applicable",
      workState: doneWorkState(),
      at: "2026-07-19T10:00:01.000Z",
    });

    expect(turn).toMatchObject({
      streamId: "S-1",
      currentMessageId: "M-1",
      run: { runId: "RUN-1", streamId: "S-1", triggerSeq: 1 },
    });
    expect(turn.context).toMatchObject({
      current: { inputSeq: 1, runId: "RUN-1" },
      agentStream: { meta: { streamId: "S-1" } },
    });
    expect(fixture.prepareAgentRun).toHaveBeenCalledTimes(1);
    expect(fixture.getAgentContext).not.toHaveBeenCalled();
    expect(fixture.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:finalize",
      runId: "RUN-1",
      streamSummary: "Explained the context engine.",
    }));
  });

  it("returns the updated authoritative context after each persisted run step", async () => {
    const fixture = serviceFixture();
    const events: ContextEngineObservabilityEvent[] = [];
    const runtime = createContextEngineRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
      observer: new ContextEngineObserver("context-engine-harness", (event) => events.push(event)),
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Read the implementation.",
      at: AT,
    });
    fixture.setContext(contextAfterStep());

    const projection = await runtime.recordRunStep({
      turn,
      record: {
        v: 1,
        runId: "RUN-1",
        step: 1,
        status: "completed",
        completedAt: "2026-07-19T10:00:02.000Z",
        summary: "Source was read.",
        toolCalls: [{
          callId: "read-source",
          tool: "read_files",
          purpose: "Inspect source",
          status: "success",
          input: { path: "src/index.ts" },
          output: "source",
        }],
        verification: {
          passed: true,
          summary: "Source read.",
          evidenceItems: [],
          newFacts: [],
          artifacts: [],
        },
        facts: [],
        artifacts: [],
      },
    });

    expect(projection).toMatchObject({
      contextRevision: "revision-step-1",
      run: { run: { runId: "RUN-1" } },
    });
    expect(projection && "observations" in projection).toBe(false);
    expect(fixture.recordRunStep).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "RUN-1:step-1",
      runId: "RUN-1",
      record: expect.objectContaining({
        version: 1,
        toolCalls: [expect.objectContaining({
          toolPurpose: "read",
          toolEffect: "read_only",
        })],
      }),
    }));
    expect(fixture.getAgentContext).not.toHaveBeenCalled();
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "run_step_persistence_queued",
      "run_step_persisted",
    ]));
  });

  it("preserves compact permission-denial metadata in the persisted tool call", async () => {
    const fixture = serviceFixture();
    const runtime = createContextEngineRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Write an external file.",
      at: AT,
    });

    await runtime.recordRunStep({
      turn,
      record: {
        v: 1,
        runId: "RUN-1",
        step: 1,
        status: "failed",
        completedAt: "2026-07-19T10:00:02.000Z",
        summary: "External mutation was denied.",
        toolCalls: [{
          callId: "call-denied",
          tool: "write_files",
          purpose: "Write the requested external file.",
          status: "failed",
          input: {
            files: [{
              path: "/external/report.txt",
              content: "must not be written",
            }],
          },
          error: "Mutation path is outside the configured workspace.",
          code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
          errorCategory: "permission",
          errorTarget: "/external/report.txt",
          operationStatus: "failed",
        }],
        verification: {
          passed: false,
          summary: "The requested mutation did not execute.",
          evidenceItems: [],
          newFacts: [],
          artifacts: [],
        },
        facts: [],
        artifacts: [],
      },
    });

    expect(fixture.recordRunStep).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        status: "failed",
        toolCalls: [expect.objectContaining({
          callId: "call-denied",
          status: "failed",
          code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
          errorCategory: "permission",
          errorTarget: "/external/report.txt",
          operationStatus: "failed",
        })],
      }),
    }));
  });

  it("persists a WorkState checkpoint through its dedicated service operation", async () => {
    const fixture = serviceFixture();
    const runtime = createContextEngineRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Continue the complex implementation.",
      at: AT,
    });
    fixture.setContext(contextAfterWorkStateCheckpoint());

    const result = await runtime.checkpointRunWorkState({
      turn,
      reason: "plan",
      workState: {
        status: "in_progress",
        summary: "The contract is complete and runtime wiring remains.",
        plan: [{
          id: "runtime",
          task: "Wire the runtime.",
          status: "active",
        }],
        importantContext: [],
        nextAction: "Wire the runtime.",
      },
      runtime: {
        revision: 0,
        afterStep: 0,
        updateReason: "initial",
      },
      afterStep: 0,
      at: "2026-07-19T10:00:02.000Z",
    });

    expect(fixture.checkpointRunWorkState).toHaveBeenCalledWith({
      requestId: "RUN-1:work-state-plan-1",
      runId: "RUN-1",
      expectedRevision: 0,
      afterStep: 0,
      reason: "plan",
      workState: {
        status: "in_progress",
        summary: "The contract is complete and runtime wiring remains.",
        plan: [{
          id: "runtime",
          task: "Wire the runtime.",
          status: "active",
        }],
        importantContext: [],
        nextAction: "Wire the runtime.",
      },
      at: "2026-07-19T10:00:02.000Z",
    });
    expect(result).toMatchObject({
      context: { contextRevision: "revision-work-state-1" },
      runtime: {
        revision: 1,
        afterStep: 0,
        updateReason: "plan",
      },
    });
    expect(turn.context.contextRevision).toBe("revision-work-state-1");
  });

  it("does not poison later persistence after one service failure", async () => {
    const fixture = serviceFixture();
    const runtime = createContextEngineRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Retry a failed persistence operation.",
      at: AT,
    });
    fixture.recordRunStep.mockRejectedValueOnce(new Error("temporary persistence failure"));

    await expect(runtime.recordRunStep({ turn, record: runtimeStepRecord() }))
      .rejects.toThrow("temporary persistence failure");

    fixture.setContext(contextAfterStep());
    await expect(runtime.recordRunStep({ turn, record: runtimeStepRecord() }))
      .resolves.toMatchObject({ contextRevision: "revision-step-1" });
    expect(fixture.recordRunStep).toHaveBeenCalledTimes(2);
    expect(fixture.getAgentContext).not.toHaveBeenCalled();
  });

  it("commits a pressure checkpoint atomically and notifies personal-memory extraction", async () => {
    const fixture = serviceFixture();
    const onCommitted = vi.fn();
    const runtime = createContextEngineRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
      onContextCheckpointCommitted: onCommitted,
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Preserve this request.",
      at: AT,
    });
    const coordinator = runtime.contextCheckpointCoordinator(turn);
    const plan = await coordinator.plan({
      protectFromSeq: 2,
      requiredSavingsTokens: 800,
      estimatedCheckpointTokens: 1_200,
    });
    const committed = await coordinator.commit({
      plan,
      summary: checkpointSummary(),
      tokenCount: 220,
      provider: "test-provider",
      model: "test-model",
    });

    expect(committed.checkpoint.checkpointId).toBe("CHK-1");
    expect(committed.context.contextRevision).toBeDefined();
    expect(fixture.planContextCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      streamId: "S-1",
      protectFromSeq: 2,
      requiredSavingsTokens: 800,
    }));
    expect(fixture.commitContextCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      plan,
      tokenCount: 220,
    }));
    expect(onCommitted).toHaveBeenCalledWith({
      streamId: "S-1",
      plan,
      checkpoint: committed.checkpoint,
    });
  });
});

function serviceFixture() {
  let context = agentContextFixture();
  const prepareAgentRun = vi.fn(async () => ({
    stream: context.stream!.stream,
    streamCreated: true,
    message: context.stream!.recentMessages[0]!,
    run: context.run!.run,
    context,
  }));
  const getAgentContext = vi.fn(async () => context);
  const recordRunStep = vi.fn(async (): Promise<RecordRunStepResponse> => ({
    run: context.run!,
    context,
  }));
  const checkpointRunWorkState = vi.fn(async (): Promise<CheckpointRunWorkStateResponse> => ({
    run: context.run!,
    context,
  }));
  const finalizeRun = vi.fn(async (): Promise<FinalizeRunResponse> => ({
    run: {
      ...context.run!.run,
      status: "done",
      stopReason: "completed",
      completedAt: "2026-07-19T10:00:01.000Z",
    },
    assistantMessage: {
      messageId: "M-2",
      streamId: "S-1",
      runId: "RUN-1",
      sequence: 2,
      role: "assistant",
      content: "Done.",
      contentHash: "sha256:assistant",
      at: "2026-07-19T10:00:01.000Z",
    },
    resourceEffects: { status: "none", events: [] },
    workstreamContextCommit: { status: "not_required" },
  }));
  const plan = checkpointPlan(context);
  const checkpoint = checkpointRecord();
  const checkpointContext = {
    ...context,
    contextRevision: "revision-checkpoint",
    stream: { ...context.stream!, checkpoint },
  };
  const planContextCheckpoint = vi.fn(async () => plan);
  const commitContextCheckpoint = vi.fn(async () => ({ checkpoint, context: checkpointContext }));
  const service = {
    prepareAgentRun,
    getAgentContext,
    recordRunStep,
    checkpointRunWorkState,
    finalizeRun,
    planContextCheckpoint,
    commitContextCheckpoint,
  } as unknown as ContextEngineService;
  return {
    service,
    prepareAgentRun,
    getAgentContext,
    recordRunStep,
    checkpointRunWorkState,
    finalizeRun,
    planContextCheckpoint,
    commitContextCheckpoint,
    setContext(value: AgentContextProjection) {
      context = value;
    },
  };
}

function contextAfterStep(): AgentContextProjection {
  return agentContextFixture({
    contextRevision: "revision-step-1",
  });
}

function contextAfterWorkStateCheckpoint(): AgentContextProjection {
  const context = agentContextFixture({
    contextRevision: "revision-work-state-1",
  });
  context.run!.workState = {
    runId: "RUN-1",
    revision: 1,
    afterStep: 0,
    status: "in_progress",
    summary: "The contract is complete and runtime wiring remains.",
    plan: [{
      id: "runtime",
      task: "Wire the runtime.",
      status: "active",
    }],
    importantContext: [],
    nextAction: "Wire the runtime.",
    updateReason: "plan",
    updatedAt: "2026-07-19T10:00:02.000Z",
  };
  return context;
}

function runtimeStepRecord() {
  return {
    v: 1 as const,
    runId: "RUN-1",
    step: 1,
    status: "completed" as const,
    completedAt: "2026-07-19T10:00:02.000Z",
    summary: "Source was read.",
    toolCalls: [{
      callId: "read-source",
      tool: "read_files",
      purpose: "Inspect source",
      status: "success" as const,
      input: { path: "src/index.ts" },
      output: "source",
    }],
    verification: {
      passed: true,
      summary: "Source read.",
      evidenceItems: [],
      newFacts: [],
      artifacts: [],
    },
    facts: [],
    artifacts: [],
  };
}

function checkpointPlan(context: AgentContextProjection): ContextCheckpointPlan {
  const message = context.stream!.recentMessages[0]!;
  return {
    planId: "PLAN-1",
    streamId: "S-1",
    selectedMessages: [message],
    exactTail: [],
    coveredFromSeq: 1,
    coveredToSeq: 1,
    sourceHash: "sha256:source",
    estimatedCheckpointTokens: 1_200,
    triggered: true,
  };
}

function checkpointRecord(): ContextCheckpointRecord {
  return {
    checkpointId: "CHK-1",
    streamId: "S-1",
    coveredFromSeq: 1,
    coveredToSeq: 1,
    sourceHash: "sha256:source",
    schemaVersion: 1,
    summary: checkpointSummary(),
    exactAnchors: [1],
    tokenCount: 220,
    reason: "context_pressure",
    provider: "test-provider",
    model: "test-model",
    createdAt: "2026-07-19T10:00:02.000Z",
  };
}

function checkpointSummary() {
  return {
    userRequests: [{ seq: 1, text: "Preserve this request." }],
    constraints: [],
    decisions: [],
    corrections: [],
    importantFacts: [],
    unresolvedQuestions: [],
    references: [],
    narrative: "The user asked to preserve this request.",
  };
}

function inProgressWorkState() {
  return {
    status: "in_progress" as const,
    summary: "Source was read.",
    plan: [],
    importantContext: [],
  };
}

function doneWorkState() {
  return { ...inProgressWorkState(), status: "done" as const };
}
