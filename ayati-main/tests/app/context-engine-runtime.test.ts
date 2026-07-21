import type {
  AgentContextProjection,
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

  it("refreshes reusable observations after each persisted run step", async () => {
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
    fixture.setContext(contextWithEvidence());

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
        workStateAfter: inProgressWorkState(),
        facts: [],
        artifacts: [],
      },
    });

    expect(projection?.observations.evidence).toHaveLength(1);
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

    fixture.setContext(contextWithEvidence());
    await expect(runtime.recordRunStep({ turn, record: runtimeStepRecord() }))
      .resolves.toMatchObject({ observations: { evidence: [expect.any(Object)] } });
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
    const checkpoint = await coordinator.commit({
      plan,
      summary: checkpointSummary(),
      tokenCount: 220,
      provider: "test-provider",
      model: "test-model",
    });

    expect(checkpoint.checkpointId).toBe("CHK-1");
    expect(fixture.planContextCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      streamId: "S-1",
      protectFromSeq: 2,
      requiredSavingsTokens: 800,
    }));
    expect(fixture.commitContextCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      plan,
      tokenCount: 220,
    }));
    expect(onCommitted).toHaveBeenCalledWith({ streamId: "S-1", plan, checkpoint });
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
    observationRevision: context.observationRevision,
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
    finalizeRun,
    planContextCheckpoint,
    commitContextCheckpoint,
  } as unknown as ContextEngineService;
  return {
    service,
    prepareAgentRun,
    getAgentContext,
    recordRunStep,
    finalizeRun,
    planContextCheckpoint,
    commitContextCheckpoint,
    setContext(value: AgentContextProjection) {
      context = value;
    },
  };
}

function contextWithEvidence(): AgentContextProjection {
  return agentContextFixture({
    contextRevision: "revision-step-1",
    observations: {
      revision: "observations:read-1",
      inventory: [],
      discovery: [],
      evidence: [{
        observationId: "OBS-1",
        streamId: "S-1",
        sourceRunId: "RUN-1",
        sourceStep: 1,
        sourceCallId: "read-source",
        kind: "evidence",
        queryKey: "read_files:source",
        purpose: "Inspect source",
        preview: "source",
        retention: "evidence_only",
        resources: [],
        createdAt: "2026-07-19T10:00:02.000Z",
      }],
    },
  });
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
    workStateAfter: inProgressWorkState(),
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
    status: "not_done" as const,
    summary: "Source was read.",
    openWork: [],
    blockers: [],
    verifiedFacts: [],
    evidence: [],
  };
}

function doneWorkState() {
  return { ...inProgressWorkState(), status: "done" as const };
}
