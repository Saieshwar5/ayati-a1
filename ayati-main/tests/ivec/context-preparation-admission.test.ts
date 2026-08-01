import { describe, expect, it, vi } from "vitest";
import type {
  ContextCheckpointPlan,
  ContextCheckpointRecord,
  ContextCheckpointSummary,
  StreamMessage,
} from "ayati-context-engine";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { AgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import { buildCoreCapsule } from "../../src/ivec/agent-runner/core-capsule.js";
import { compilePreparedMainContext } from "../../src/ivec/context-preparation/main-admission.js";
import {
  ContextPreparationManager,
  type ContextPreparationJob,
} from "../../src/ivec/context-preparation/manager.js";
import type { AgentContextCheckpointCoordinator } from "../../src/ivec/types.js";

const AT = "2026-07-21T10:00:00.000Z";

describe("prepared main-context admission", () => {
  it("generates and commits a durable checkpoint only through context maintenance", async () => {
    const fixture = await preparedDurableFixture();

    expect(fixture.commit).not.toHaveBeenCalled();
    const compilation = await compilePreparedMainContext({
      provider: fixture.provider,
      stateView: fixture.originalState,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager: fixture.manager,
      contextCheckpoint: fixture.coordinator,
      contextMaintenance: fixture.contextMaintenance,
      buildPrompt: prompt,
      applyAuthoritativeContext: fixture.applyAuthoritativeContext,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
    });

    expect(fixture.commit).toHaveBeenCalledTimes(1);
    expect(fixture.applyAuthoritativeContext).toHaveBeenCalledWith(fixture.freshContext);
    expect(compilation.receipt).toMatchObject({
      mode: "stream_checkpoint",
      candidateAction: "adopted",
      candidate: { kind: "durable_checkpoint", status: "adopted" },
      admitted: true,
    });
    expect(compilation.streamCheckpoint?.checkpoint?.checkpointId).toBe("CHK-adopted");
    const finalPrompt = compilation.finalTurnInput.messages.find((message) => message.role === "user")?.content;
    expect(finalPrompt).toContain("FRESH-WORK");
    if (typeof finalPrompt !== "string") throw new Error("Expected a serialized state prompt.");
    const finalState = JSON.parse(finalPrompt.slice(finalPrompt.indexOf("{"))) as AgentStateView;
    expect(finalState.context.core.continuity.recentExact.map((event) => event.seq)).toEqual([3, 4]);
    expect(finalState.context.core.current.input.seq).toBe(5);
    expect(finalState.context.core.continuity.checkpoint?.coveredToSeq).toBe(2);
    expect(fixture.contextMaintenance.enter).toHaveBeenCalledTimes(1);
    expect(fixture.contextMaintenance.exit).toHaveBeenCalledTimes(1);
  });

  it("does not create a durable checkpoint outside the context-maintenance lifecycle", async () => {
    const fixture = await preparedDurableFixture();

    const compilation = await compilePreparedMainContext({
      provider: fixture.provider,
      stateView: fixture.originalState,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager: fixture.manager,
      contextCheckpoint: fixture.coordinator,
      buildPrompt: prompt,
      applyAuthoritativeContext: fixture.applyAuthoritativeContext,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
    });

    expect(fixture.coordinator.plan).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(compilation.receipt.candidateAction).toBe("none");
  });

  it("maintains the Core Capsule below whole-prompt pressure when its own budget is exceeded", async () => {
    const fixture = await preparedDurableFixture();
    fixture.originalState.context.core = buildCoreCapsule({
      revision: "core:oversized",
      runId: "RUN-1",
      continuityMaxTokens: 300,
      timeline: [
        { kind: "user", seq: 1, timestamp: AT, content: "A".repeat(6_000) },
        { kind: "assistant", seq: 2, timestamp: AT, content: "B".repeat(6_000) },
        { kind: "user", seq: 3, timestamp: AT, content: "Recent request" },
        { kind: "assistant", seq: 4, timestamp: AT, content: "Recent response" },
        { kind: "user", seq: 5, timestamp: AT, content: "CURRENT", current: true },
      ],
      routing: { status: "unbound" },
    });
    expect(fixture.originalState.context.core.continuity.maintenanceRequired).toBe(true);
    const enter = vi.fn();
    const exit = vi.fn(() => fixture.freshState);

    const compilation = await compilePreparedMainContext({
      provider: fixture.provider,
      stateView: fixture.originalState,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager: fixture.manager,
      contextCheckpoint: fixture.coordinator,
      buildPrompt: prompt,
      applyAuthoritativeContext: fixture.applyAuthoritativeContext,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
      contextMaintenance: { enter, exit },
    });

    expect(compilation.candidateBudget.measuredInputTokens).toBeLessThan(55_000);
    expect(fixture.coordinator.plan).toHaveBeenCalledTimes(1);
    expect(fixture.commit).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith(expect.objectContaining({
      reason: "continuity_budget",
      protectFromSeq: 3,
      continuityMaxTokens: 300,
    }));
    expect(exit).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      reason: "checkpoint_committed",
      checkpointId: "CHK-adopted",
    }));
    expect(compilation.receipt).toMatchObject({
      mode: "stream_checkpoint",
      candidateAction: "adopted",
      candidate: { kind: "durable_checkpoint", status: "adopted" },
    });
  });

  it("installs a deterministic fallback after one malformed maintenance response", async () => {
    const fixture = await preparedDurableFixture();
    fixture.provider.generateTurn = vi.fn().mockResolvedValue({
      type: "assistant" as const,
      content: "not valid checkpoint json",
    });
    const enter = vi.fn();
    const exit = vi.fn(() => fixture.freshState);

    const compile = async () => await compilePreparedMainContext({
      provider: fixture.provider,
      stateView: fixture.originalState,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager: fixture.manager,
      contextCheckpoint: fixture.coordinator,
      buildPrompt: prompt,
      applyAuthoritativeContext: fixture.applyAuthoritativeContext,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
      contextMaintenance: { enter, exit },
    });

    const compilation = await compile();
    expect(compilation.receipt).toMatchObject({
      mode: "stream_checkpoint",
      candidateAction: "adopted",
      candidate: { kind: "durable_checkpoint", status: "adopted" },
    });
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      checkpointId: "CHK-adopted",
    }));
    expect(fixture.provider.generateTurn).toHaveBeenCalledTimes(1);
    expect(fixture.commit).toHaveBeenCalledTimes(1);
    expect(fixture.manager.currentCandidate()?.checkpointGeneration).toMatchObject({
      status: "success",
      generationMethod: "deterministic_fallback",
      attempts: [{ status: "failed", providerCalled: true }],
    });
  });

  it("runs conversation maintenance independently of tool-projection shadow mode", async () => {
    const fixture = await preparedDurableFixture();
    const compilation = await compilePreparedMainContext({
      provider: fixture.provider,
      stateView: fixture.originalState,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "shadow",
      manager: fixture.manager,
      contextCheckpoint: fixture.coordinator,
      contextMaintenance: fixture.contextMaintenance,
      buildPrompt: prompt,
      applyAuthoritativeContext: fixture.applyAuthoritativeContext,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
    });

    expect(fixture.commit).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.plan).toHaveBeenCalledTimes(1);
    expect(fixture.applyAuthoritativeContext).toHaveBeenCalledWith(fixture.freshContext);
    expect(fixture.contextMaintenance.enter).toHaveBeenCalledTimes(1);
    expect(fixture.contextMaintenance.exit).toHaveBeenCalledTimes(1);
    expect(compilation.receipt).toMatchObject({
      mode: "stream_checkpoint",
      candidateAction: "adopted",
      toolProjectionPolicy: "shadow",
    });
    expect(compilation.finalTurnInput.messages.find((message) => message.role === "user")?.content)
      .toContain("FRESH-WORK");
  });

  it("rejects a changed checkpoint base without moving the durable pointer", async () => {
    const fixture = await preparedDurableFixture();
    fixture.setAuthoritativeContext(machineContext(previousCheckpoint("CHK-new-base")));

    const compilation = await compilePreparedMainContext({
      provider: fixture.provider,
      stateView: fixture.originalState,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager: fixture.manager,
      contextCheckpoint: fixture.coordinator,
      contextMaintenance: fixture.contextMaintenance,
      buildPrompt: prompt,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
    });

    expect(fixture.commit).not.toHaveBeenCalled();
    expect(compilation.receipt).toMatchObject({
      candidateAction: "rejected",
      candidateReason: "checkpoint_base_changed",
      candidate: { status: "stale" },
    });
    expect(fixture.coordinator.currentContext().agentStream.checkpoint?.checkpointId).toBe("CHK-new-base");
  });

  it("leaves the active pointer unchanged when Context Engine rejects a stale source hash", async () => {
    const fixture = await preparedDurableFixture();
    fixture.commit.mockRejectedValueOnce(new Error("checkpoint source hash changed"));

    const compilation = await compilePreparedMainContext({
      provider: fixture.provider,
      stateView: fixture.originalState,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager: fixture.manager,
      contextCheckpoint: fixture.coordinator,
      contextMaintenance: fixture.contextMaintenance,
      buildPrompt: prompt,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
    });

    expect(compilation.receipt).toMatchObject({
      candidateAction: "rejected",
      candidateReason: "checkpoint_commit_rejected:checkpoint source hash changed",
      candidate: { status: "stale" },
    });
    expect(fixture.coordinator.currentContext().agentStream.checkpoint).toBeUndefined();
  });

  it("does not commit a checkpoint that cannot reduce context at the forced barrier", async () => {
    const fixture = await preparedDurableFixture();
    fixture.originalState.context.hot.loaded[0]!.content = "x".repeat(300_000);
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "test",
      model: "test-model",
      inputTokens: 90_000,
      exact: true,
    });
    const provider: LlmProvider = {
      ...fixture.provider,
      countInputTokens,
    };

    const compilation = await compilePreparedMainContext({
      provider,
      stateView: fixture.originalState,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager: fixture.manager,
      contextCheckpoint: fixture.coordinator,
      contextMaintenance: fixture.contextMaintenance,
      buildPrompt: prompt,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
    });

    expect(fixture.commit).not.toHaveBeenCalled();
    expect(compilation.receipt).toMatchObject({
      candidateAction: "rejected",
      candidateReason: "checkpoint_candidate_did_not_reduce_context",
      candidate: { status: "stale" },
    });
  });

  it("rejects a durable candidate that overlaps an active focus owner", async () => {
    const fixture = await preparedDurableFixture();
    fixture.manager.setOverlay({
      candidateId: "CTX-focus",
      summary: {
        schemaVersion: 1,
        coveredMessageRange: { fromSeq: 1, toSeq: 1 },
        goal: "Preserve earlier context.",
        constraints: [],
        decisions: [],
        completedWork: [],
        importantFindings: [{ text: "Earlier request remains relevant.", refs: ["seq:1"] }],
        artifacts: [],
        unresolvedQuestions: [],
        references: ["seq:1"],
      },
      coveredSourceRefs: ["seq:1"],
      canonicalSourceHashes: {},
    });

    const compilation = await compilePreparedMainContext({
      provider: fixture.provider,
      stateView: fixture.originalState,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager: fixture.manager,
      contextCheckpoint: fixture.coordinator,
      contextMaintenance: fixture.contextMaintenance,
      buildPrompt: prompt,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
    });

    expect(fixture.commit).not.toHaveBeenCalled();
    expect(compilation.receipt).toMatchObject({
      candidateAction: "rejected",
      candidateReason: "overlapping_prefix_ownership",
      candidate: { status: "stale" },
    });
  });

  it("does not wait for a pending candidate below the exact forced barrier", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "test",
      model: "test-model",
      inputTokens: 80_000,
      exact: true,
    });
    const provider = countingProvider(countInputTokens);
    const manager = new ContextPreparationManager({ laneId: "main:RUN-1", provider });
    manager.startBackground(pendingFocusJob(pending));
    const state = stateView("ORIGINAL-WORK", true);
    const current = state.context.core.current.input;
    current.content = "x".repeat(300_000);

    const compilation = await compilePreparedMainContext({
      provider,
      stateView: state,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager,
      buildPrompt: prompt,
      allowBackgroundPreparation: true,
      allowSynchronousSemanticRecovery: false,
    });

    expect(compilation.finalBudget.measuredInputTokens).toBe(80_000);
    expect(compilation.receipt.admitted).toBe(true);
    expect(compilation.receipt.forcedRecovery).toBeUndefined();
    expect(manager.currentCandidate()?.status).toBe("preparing");
    manager.close("test_complete");
    release();
  });

  it("adopts a pre-binding focus candidate without replacing fresh execute authority or routing evidence", async () => {
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "test",
      model: "test-model",
      inputTokens: 80_000,
      exact: true,
    });
    const provider = countingProvider(countInputTokens);
    const manager = new ContextPreparationManager({ laneId: "main:RUN-1", provider });
    const candidate = await manager.prepareSynchronously(pendingFocusJob(Promise.resolve()));
    if (!candidate) throw new Error("Expected a ready focus candidate.");

    const state = stateView("BOUND-WORK", true);
    state.context.core.current.routing = {
      status: "bound",
      workstreamId: "W-BOUND",
      requestId: "R-BOUND",
    };
    state.context.run = {
      boundWorkstream: {
        id: "W-BOUND",
        title: "Bound project",
        purpose: "Own the verified target.",
        summary: "The request is ready to execute.",
        lifecycleStatus: "active",
        blockers: [],
        request: {
          id: "R-BOUND",
          title: "Write the result",
          status: "active",
          request: "Write result.txt.",
          acceptance: ["result.txt is verified."],
          constraints: [],
        },
        recentProgress: [],
        resources: [],
        otherResourceCount: 0,
      },
      mode: {
        active: "execute",
        revision: 3,
        purpose: "Write the verified target.",
        capabilities: ["file:write"],
        targets: ["result.txt"],
        allowedNext: ["execute", "observe.locate", "observe.investigate", "validate"],
      },
      workState: {
        status: "in_progress",
        summary: "Binding is complete.",
        plan: [],
        importantContext: [{
          kind: "finding",
          value: "Binding is complete.",
          ref: "run:RUN-1:step:1:call:route-1",
        }],
      },
      toolCalls: [{
        step: 1,
        callId: "route-1",
        tool: "git_context_read_workstream",
        purpose: "Read the selected workstream.",
        input: { workstreamId: "W-BOUND" },
        status: "success",
        verificationStatus: "passed",
        mode: "full",
        output: "Authoritative workstream W-BOUND",
        evidenceRef: "run:RUN-1:step:1:call:route-1",
      }],
      verifiedOutcomes: [{
        outcomeRef: "run:RUN-1:step:2:call:write-result:outcome:0",
        kind: "file.written",
        subject: "/workspace/result.txt",
        actualKind: "file",
        source: {
          step: 2,
          callId: "write-result",
          tool: "write_files",
        },
      }],
    };

    const compilation = await compilePreparedMainContext({
      provider,
      stateView: state,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager,
      buildPrompt: prompt,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: false,
    });

    expect(compilation.receipt).toMatchObject({
      candidateAction: "adopted",
      candidate: { kind: "run_focus", status: "adopted" },
    });
    const finalPrompt = compilation.finalTurnInput.messages.find((message) => message.role === "user")?.content;
    if (typeof finalPrompt !== "string") throw new Error("Expected a serialized state prompt.");
    const finalState = JSON.parse(finalPrompt.slice(finalPrompt.indexOf("{"))) as AgentStateView;
    expect(finalState.context.core.current.routing).toEqual({
      status: "bound",
      workstreamId: "W-BOUND",
      requestId: "R-BOUND",
    });
    expect(finalState.context.run?.mode).toMatchObject({ active: "execute", revision: 3 });
    expect(finalState.context.run?.boundWorkstream).toEqual(
      state.context.run.boundWorkstream,
    );
    expect(finalState.context.run?.workState?.importantContext).toContainEqual(
      expect.objectContaining({ ref: "run:RUN-1:step:1:call:route-1" }),
    );
    expect(finalState.context.run?.toolCalls?.[0]).toMatchObject({
      callId: "route-1",
      evidenceRef: "run:RUN-1:step:1:call:route-1",
      mode: "full",
    });
    expect(finalState.context.run?.verifiedOutcomes).toEqual([{
      outcomeRef: "run:RUN-1:step:2:call:write-result:outcome:0",
      kind: "file.written",
      subject: "/workspace/result.txt",
      actualKind: "file",
      source: {
        step: 2,
        callId: "write-result",
        tool: "write_files",
      },
    }]);
  });

  it("waits once and adopts a relevant pending candidate at the exact forced barrier", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const countInputTokens = vi.fn()
      .mockResolvedValueOnce({ provider: "test", model: "test-model", inputTokens: 90_000, exact: true })
      .mockResolvedValue({ provider: "test", model: "test-model", inputTokens: 50_000, exact: true });
    const provider = countingProvider(countInputTokens);
    const manager = new ContextPreparationManager({ laneId: "main:RUN-1", provider });
    manager.startBackground(pendingFocusJob(pending));
    const state = stateView("ORIGINAL-WORK", true);
    const current = state.context.core.current.input;
    current.content = "x".repeat(300_000);

    let settled = false;
    const compilationPromise = compilePreparedMainContext({
      provider,
      stateView: state,
      turnInput: turnInput(),
      contextLimits: limits(),
      decisionAttempt: 1,
      policy: "enforce",
      manager,
      buildPrompt: prompt,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: false,
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    const compilation = await compilationPromise;
    expect(compilation.receipt).toMatchObject({
      forcedRecovery: true,
      candidateAction: "adopted",
      candidate: { kind: "run_focus", status: "adopted" },
      finalInputTokens: 50_000,
      admitted: true,
    });
  });
});

async function preparedDurableFixture() {
  const generateTurn = vi.fn().mockResolvedValue({
    type: "assistant" as const,
    content: JSON.stringify(checkpointSummary()),
  });
  const provider: LlmProvider = {
    name: "test",
    version: "test-model",
    capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true, jsonSchema: true } },
    start() {},
    stop() {},
    generateTurn,
  };
  let authoritativeContext = machineContext();
  let checkpointCommitted = false;
  const plan = checkpointPlan();
  const freshContext = machineContext(adoptedCheckpoint());
  const commit = vi.fn(async () => {
    checkpointCommitted = true;
    authoritativeContext = freshContext;
    return { checkpoint: adoptedCheckpoint(), context: freshContext };
  });
  const coordinator: AgentContextCheckpointCoordinator = {
    plan: vi.fn().mockResolvedValue(plan),
    commit,
    currentContext: () => authoritativeContext,
  };
  const originalState = stateView("ORIGINAL-WORK", true);
  originalState.context.core = buildCoreCapsule({
    revision: "core:maintenance-required",
    runId: "RUN-1",
    continuityMaxTokens: 1,
    timeline: [
      { kind: "user", seq: 1, timestamp: AT, content: "Earlier request" },
      { kind: "assistant", seq: 2, timestamp: AT, content: "Earlier response" },
      { kind: "user", seq: 3, timestamp: AT, content: "Recent request" },
      { kind: "assistant", seq: 4, timestamp: AT, content: "Recent response" },
      { kind: "user", seq: 5, timestamp: AT, content: "CURRENT", current: true },
    ],
    routing: { status: "unbound" },
  });
  const freshState = stateView("FRESH-WORK", false, adoptedCheckpoint());
  freshState.context.core = buildCoreCapsule({
    revision: "checkpoint:CHK-adopted",
    runId: "RUN-1",
    continuityMaxTokens: 1,
    checkpoint: adoptedCheckpoint(),
    timeline: [
      { kind: "user", seq: 3, timestamp: AT, content: "Recent request" },
      { kind: "assistant", seq: 4, timestamp: AT, content: "Recent response" },
      { kind: "user", seq: 5, timestamp: AT, content: "CURRENT", current: true },
    ],
    routing: { status: "unbound" },
  });
  const contextMaintenance = {
    enter: vi.fn(),
    exit: vi.fn(() => checkpointCommitted ? freshState : originalState),
  };
  const applyAuthoritativeContext = vi.fn(() => freshState);
  const manager = new ContextPreparationManager({ laneId: "main:RUN-1", provider });
  return {
    provider,
    manager,
    coordinator,
    commit,
    originalState,
    freshState,
    freshContext,
    contextMaintenance,
    applyAuthoritativeContext,
    setAuthoritativeContext(value: ContextEngineMachineContext) {
      authoritativeContext = value;
    },
  };
}

function stateView(
  recentWorkMarker: string,
  includeHistory: boolean,
  checkpoint?: ContextCheckpointRecord,
): AgentStateView {
  const timeline = [
    ...(includeHistory ? [
      { kind: "user" as const, seq: 1, timestamp: AT, content: "Earlier request" },
      { kind: "assistant" as const, seq: 2, timestamp: AT, content: "Earlier response" },
    ] : []),
    { kind: "user" as const, seq: 3, timestamp: AT, content: "CURRENT", current: true as const },
  ];
  return {
    context: {
      core: buildCoreCapsule({
        revision: checkpoint ? `checkpoint:${checkpoint.checkpointId}` : "core:1",
        runId: "RUN-1",
        timeline,
        ...(checkpoint ? { checkpoint } : {}),
        routing: { status: "unbound" },
      }),
      hot: {
        available: [],
        loaded: [{
          key: "test.marker",
          description: "Context admission marker.",
          version: `version:${recentWorkMarker}`,
          estimatedTokens: 4,
          freshness: "current",
          sourceRefs: ["test:marker"],
          content: recentWorkMarker,
          mountedAtStep: 0,
        }],
        budget: {
          maxMountedTokens: 8_000,
          mountedTokens: 4,
        },
      },
      work: { candidates: [] },
      resources: { stream: [], ingress: [], activeWorkstream: [] },
      run: {
        workState: {
          status: "in_progress",
          summary: "Continue.",
          plan: [],
          importantContext: [],
        },
      },
    },
  };
}

function checkpointPlan(): ContextCheckpointPlan {
  return {
    planId: "PLAN-1",
    streamId: "S-1",
    selectedMessages: [
      message(1, "user", "Earlier request"),
      message(2, "assistant", "Earlier response"),
    ],
    exactTail: [
      message(3, "user", "Recent request"),
      message(4, "assistant", "Recent response"),
      message(5, "user", "CURRENT"),
    ],
    coveredFromSeq: 1,
    coveredToSeq: 2,
    sourceHash: "sha256:source",
    estimatedCheckpointTokens: 1_200,
    triggered: true,
  };
}

function checkpointSummary(): ContextCheckpointSummary {
  return {
    userRequests: [{ seq: 1, text: "Earlier request" }],
    constraints: [],
    decisions: [{ seq: 2, text: "Earlier response" }],
    corrections: [],
    importantFacts: [],
    unresolvedQuestions: [],
    references: [],
    narrative: "Earlier context was checkpointed.",
  };
}

function adoptedCheckpoint(): ContextCheckpointRecord {
  return {
    checkpointId: "CHK-adopted",
    streamId: "S-1",
    coveredFromSeq: 1,
    coveredToSeq: 2,
    sourceHash: "sha256:source",
    schemaVersion: 1,
    summary: checkpointSummary(),
    exactAnchors: [1, 2],
    tokenCount: 80,
    reason: "context_pressure",
    provider: "test",
    model: "test-model",
    createdAt: AT,
  };
}

function previousCheckpoint(checkpointId: string): ContextCheckpointRecord {
  return { ...adoptedCheckpoint(), checkpointId, coveredToSeq: 1, exactAnchors: [1] };
}

function machineContext(checkpoint?: ContextCheckpointRecord): ContextEngineMachineContext {
  return {
    contextRevision: checkpoint ? `context:${checkpoint.checkpointId}` : "context:initial",
    streamRevision: "stream:1",
    agentStream: {
      meta: {
        streamId: "S-1",
        agentId: "local",
        scopeKey: "default",
        createdAt: AT,
        updatedAt: AT,
        lastMessageSequence: 5,
        lastRunSequence: 1,
        resourceCount: 0,
      },
      ...(checkpoint ? { checkpoint } : {}),
      recentMessages: [
        message(3, "user", "Recent request"),
        message(4, "assistant", "Recent response"),
        message(5, "user", "CURRENT"),
      ],
      recentWorkstreams: [],
      recentFiles: [],
      resources: [],
    },
    current: { inputSeq: 5, runId: "RUN-1", routing: { status: "unbound" } },
    focus: { status: "none" },
    warnings: [],
  };
}

function message(sequence: number, role: StreamMessage["role"], content: string): StreamMessage {
  return {
    messageId: `MSG-${sequence}`,
    streamId: "S-1",
    runId: "RUN-1",
    sequence,
    role,
    content,
    contentHash: `sha256:${sequence}`,
    at: AT,
  };
}

function turnInput() {
  return {
    messages: [
      { role: "system" as const, content: "SYSTEM" },
      { role: "user" as const, content: "Old state" },
    ],
  };
}

function pendingFocusJob(pending: Promise<void>): ContextPreparationJob {
  return {
    jobKey: "main:RUN-1:prefix:pending:1:run_focus",
    kind: "run_focus",
    seed: {
      runStepPrefixThrough: 2,
      canonicalSourceHashes: {},
      sourceRefs: ["step:1", "step:2"],
      requiredExactEvidenceRefs: [],
      policyVersion: 2,
      modelProfileVersion: "test:test-model:128000:auto:8192:55000:60000:70000:100000",
      deterministicTransformations: [],
      coveredSourceRefs: [],
      estimatedSavingsTokens: 40_000,
      estimatedFinalInputTokens: 50_000,
      targetReached: true,
    },
    prepare: async () => {
      await pending;
      return {
        focusSummary: {
          schemaVersion: 1,
          coveredStepRange: { fromStep: 1, toStep: 2 },
          goal: "Keep the current run focused.",
          constraints: [],
          decisions: [],
          completedWork: [],
          importantFindings: [],
          artifacts: [],
          unresolvedQuestions: [],
          references: [],
        },
        coveredSourceRefs: ["step:1", "step:2"],
      };
    },
  };
}

function countingProvider(countInputTokens: NonNullable<LlmProvider["countInputTokens"]>): LlmProvider {
  return {
    name: "test",
    version: "test-model",
    capabilities: { nativeToolCalling: true },
    start() {},
    stop() {},
    countInputTokens,
    generateTurn: vi.fn(),
  };
}

function prompt(state: Parameters<typeof JSON.stringify>[0]): string {
  return `State view:\n${JSON.stringify(state)}`;
}

function limits() {
  return {
    provider: "test",
    model: "test-model",
    contextWindowTokens: 128_000,
    outputReserveTokens: 8_192,
    preparationInputTokens: 55_000,
    recoveryTargetTokens: 60_000,
    softInputTokens: 70_000,
    hardInputTokens: 100_000,
    source: "configured" as const,
  };
}
