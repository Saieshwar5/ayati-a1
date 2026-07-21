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
import { compilePreparedMainContext } from "../../src/ivec/context-preparation/main-admission.js";
import { createMainPreparationJob } from "../../src/ivec/context-preparation/main-candidates.js";
import {
  ContextPreparationManager,
  type ContextPreparationJob,
} from "../../src/ivec/context-preparation/manager.js";
import type { AgentContextCheckpointCoordinator } from "../../src/ivec/types.js";

const AT = "2026-07-21T10:00:00.000Z";

describe("prepared main-context admission", () => {
  it("generates a durable candidate without committing, then adopts the fresh commit projection", async () => {
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
      buildPrompt: prompt,
      applyAuthoritativeContext: fixture.applyAuthoritativeContext,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: false,
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
    expect(finalState.context.temporal.recent.map((event) => event.seq)).toEqual([3]);
    expect(finalState.context.temporal.checkpoint?.coveredToSeq).toBe(2);
  });

  it("measures but never mounts or commits a ready candidate in shadow mode", async () => {
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
      buildPrompt: prompt,
      applyAuthoritativeContext: fixture.applyAuthoritativeContext,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: false,
    });

    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.applyAuthoritativeContext).not.toHaveBeenCalled();
    expect(compilation.receipt).toMatchObject({
      mode: "full",
      candidateAction: "measured",
      candidateReason: "shadow_policy",
      candidate: { status: "discarded" },
    });
    expect(compilation.finalTurnInput.messages.find((message) => message.role === "user")?.content)
      .toContain("Earlier request");
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
      buildPrompt: prompt,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: false,
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
      buildPrompt: prompt,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: false,
    });

    expect(compilation.receipt).toMatchObject({
      candidateAction: "rejected",
      candidateReason: "checkpoint_commit_rejected:checkpoint source hash changed",
      candidate: { status: "stale" },
    });
    expect(fixture.coordinator.currentContext().agentStream.checkpoint).toBeUndefined();
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
      buildPrompt: prompt,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: false,
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
    const current = state.context.temporal.recent.find((event) => event.current);
    if (!current || !("content" in current)) throw new Error("Expected current input.");
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
    const current = state.context.temporal.recent.find((event) => event.current);
    if (!current || !("content" in current)) throw new Error("Expected current input.");
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
  const plan = checkpointPlan();
  const freshContext = machineContext(adoptedCheckpoint());
  const commit = vi.fn(async () => {
    authoritativeContext = freshContext;
    return { checkpoint: adoptedCheckpoint(), context: freshContext };
  });
  const coordinator: AgentContextCheckpointCoordinator = {
    plan: vi.fn().mockResolvedValue(plan),
    commit,
    currentContext: () => authoritativeContext,
  };
  const originalState = stateView("ORIGINAL-WORK", true);
  const freshState = stateView("FRESH-WORK", false, adoptedCheckpoint());
  const applyAuthoritativeContext = vi.fn(() => freshState);
  const manager = new ContextPreparationManager({ laneId: "main:RUN-1", provider });
  const job = createMainPreparationJob({
    provider,
    laneId: manager.laneId,
    stateView: originalState,
    currentInputTokens: 80_000,
    predictedInputTokens: 95_000,
    recoveryTargetTokens: 60_000,
    contextLimits: limits(),
    modelProfileVersion: "test:test-model:128000:auto:8192:55000:60000:70000:100000",
    contextCheckpoint: coordinator,
    synchronous: true,
  });
  if (!job) throw new Error("Expected a durable checkpoint job.");
  const candidate = await manager.prepareSynchronously(job);
  if (!candidate) throw new Error("Expected a ready durable checkpoint candidate.");
  return {
    provider,
    manager,
    coordinator,
    commit,
    originalState,
    freshContext,
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
  return {
    context: {
      temporal: {
        ...(checkpoint ? { checkpoint } : {}),
        recent: [
          ...(includeHistory ? [
            { kind: "user" as const, seq: 1, timestamp: AT, content: "Earlier request" },
            { kind: "assistant" as const, seq: 2, timestamp: AT, content: "Earlier response" },
          ] : []),
          { kind: "user", seq: 3, timestamp: AT, content: "CURRENT", current: true },
        ],
      },
      current: { inputSeq: 3, runId: "RUN-1", routing: { status: "unbound" } },
      stream: {
        agentId: "local",
        scopeKey: "default",
        recentWork: [{
          workstreamId: "W-20260721-0001",
          requestId: recentWorkMarker,
          outcome: "done",
          resourceIds: [],
          completedAt: AT,
        }],
      },
      work: { candidates: [] },
      resources: { stream: [], ingress: [], activeWorkstream: [] },
      observations: { revision: "obs:1", inventory: [], discovery: [], evidence: [] },
      run: { workState: { status: "not_done", summary: "Continue." } },
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
    exactTail: [message(3, "user", "CURRENT")],
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
    observationRevision: "obs:1",
    agentStream: {
      meta: {
        streamId: "S-1",
        agentId: "local",
        scopeKey: "default",
        createdAt: AT,
        updatedAt: AT,
        lastMessageSequence: 3,
        lastRunSequence: 1,
        resourceCount: 0,
      },
      ...(checkpoint ? { checkpoint } : {}),
      recentMessages: [message(3, "user", "CURRENT")],
      recentWork: [],
      resources: [],
    },
    current: { inputSeq: 3, runId: "RUN-1", routing: { status: "unbound" } },
    focus: { status: "none" },
    observations: { inventory: [], discovery: [], evidence: [] },
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
      messagePrefixThroughSeq: 2,
      canonicalSourceHashes: {},
      sourceRefs: ["seq:1", "seq:2"],
      requiredExactEvidenceRefs: [],
      policyVersion: 1,
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
          coveredMessageRange: { fromSeq: 1, toSeq: 2 },
          goal: "Keep the current run focused.",
          constraints: [],
          decisions: [],
          completedWork: [],
          importantFindings: [],
          artifacts: [],
          unresolvedQuestions: [],
          references: [],
        },
        coveredSourceRefs: ["seq:1", "seq:2"],
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
