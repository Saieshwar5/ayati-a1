import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTokenUsage, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { AgentPromptStateView } from "../../src/ivec/agent-runner/prompt-context.js";
import {
  applyMainFocusOverlay,
  createMainPreparationJob,
  validateMainCandidate,
} from "../../src/ivec/context-preparation/main-candidates.js";
import {
  generateFocusSummary,
  validateFocusSummary,
} from "../../src/ivec/context-preparation/focus-summary.js";
import { ContextPreparationManager } from "../../src/ivec/context-preparation/manager.js";
import type { RunFocusSummary } from "../../src/ivec/context-preparation/types.js";

describe("anchored run-focus preparation", () => {
  it("repairs an invented ref once and aggregates both attempts", async () => {
    const invalid = focusSummary({ importantRefs: ["seq:999"] });
    const valid = focusSummary();
    const generateTurn = vi.fn()
      .mockResolvedValueOnce(assistant(invalid, usage(10, 3, 2)))
      .mockResolvedValueOnce(assistant(valid, usage(12, 4, 1)));
    const result = await generateFocusSummary({
      provider: provider(generateTurn),
      source: {
        goal: "Continue the current run.",
        validRefs: ["seq:1", "seq:2", "step:1", "step:2"],
        messages: [
          { ref: "seq:1", seq: 1, role: "user", content: "Earlier request" },
          { ref: "seq:2", seq: 2, role: "assistant", content: "Earlier response" },
        ],
        steps: [
          { refs: ["step:1"], step: 1, content: "First result" },
          { refs: ["step:2"], step: 2, content: "Second result" },
        ],
        sourceKind: "main",
      },
    });

    expect(result).toMatchObject({
      status: "success",
      attempts: [{ status: "failed" }, { status: "success" }],
      usage: {
        inputTokens: 22,
        outputTokens: 7,
        totalTokens: 29,
        cachedInputTokens: 3,
      },
    });
    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(generateTurn.mock.calls[1]?.[0].messages[0].content).toContain("invented ref seq:999");
  });

  it("rejects a focus summary above its token budget", () => {
    const oversized = focusSummary();
    oversized.importantFindings[0]!.text = "large ".repeat(2_000);
    expect(validateFocusSummary(oversized, {
      goal: "Continue the current run.",
      validRefs: ["seq:1", "seq:2", "step:1", "step:2"],
      messages: [
        { ref: "seq:1", seq: 1, role: "user", content: "Earlier request" },
        { ref: "seq:2", seq: 2, role: "assistant", content: "Earlier response" },
      ],
      steps: [
        { refs: ["step:1"], step: 1, content: "First result" },
        { refs: ["step:2"], step: 2, content: "Second result" },
      ],
      sourceKind: "main",
    }, 100)).toEqual(expect.arrayContaining([
      expect.stringMatching(/above budget 100/),
    ]));
  });

  it("does not send a semantic request above its input capacity", async () => {
    const generateTurn = vi.fn();
    const result = await generateFocusSummary({
      provider: provider(generateTurn),
      source: {
        goal: "Continue.",
        validRefs: ["seq:1"],
        messages: [{
          ref: "seq:1",
          seq: 1,
          role: "user",
          content: "x".repeat(20_000),
        }],
        steps: [],
        sourceKind: "main",
      },
      maxInputTokens: 100,
    });

    expect(result).toMatchObject({
      status: "failed",
      attempts: [{ attempt: 1, status: "failed" }],
    });
    expect(result.errors[0]).toMatch(/focus-summary input requires .* exceeding capacity 100/);
    expect(generateTurn).not.toHaveBeenCalled();
  });

  it("keeps an oversized exact message out of the disposable summary source", () => {
    const state = promptState();
    const first = state.context.temporal.recent[0];
    if (!first || !("content" in first)) throw new Error("Expected prior exact input.");
    first.content = "x".repeat(250_000);
    state.context.run!.toolCalls = [];

    expect(createMainPreparationJob({
      provider: provider(vi.fn()),
      laneId: "main:RUN-1",
      stateView: state,
      currentInputTokens: 90_000,
      predictedInputTokens: 105_000,
      recoveryTargetTokens: 60_000,
      contextLimits: limits(),
      modelProfileVersion: "profile:1",
      synchronous: true,
    })).toBeUndefined();
    expect((state.context.temporal.recent[0] as { content: string }).content).toHaveLength(250_000);
  });

  it("accepts append-only tail growth and rejects a changed covered source", async () => {
    const state = promptState();
    const generateTurn = vi.fn().mockResolvedValue(assistant(focusSummary(), usage(20, 5)));
    const llm = provider(generateTurn);
    const manager = new ContextPreparationManager({ laneId: "main:RUN-1", provider: llm });
    const job = createMainPreparationJob({
      provider: llm,
      laneId: manager.laneId,
      stateView: state,
      currentInputTokens: 80_000,
      predictedInputTokens: 95_000,
      recoveryTargetTokens: 60_000,
      contextLimits: limits(),
      modelProfileVersion: "profile:1",
      synchronous: true,
    });
    if (!job) throw new Error("Expected a focus-summary job.");

    const candidate = await manager.prepareSynchronously(job);
    if (!candidate) throw new Error("Expected a ready candidate.");
    const appended = structuredClone(state);
    appended.context.run!.toolCalls!.push(toolCall(9));

    expect(validateMainCandidate({
      candidate,
      laneId: manager.laneId,
      stateView: appended,
      modelProfileVersion: "profile:1",
    })).toEqual({ valid: true, reason: "source_hash_and_tail_valid" });

    const changed = structuredClone(appended);
    const first = changed.context.temporal.recent[0];
    if (first && "content" in first) first.content = "Changed after preparation";
    expect(validateMainCandidate({
      candidate,
      laneId: manager.laneId,
      stateView: changed,
      modelProfileVersion: "profile:1",
    })).toMatchObject({ valid: false, reason: "source_hash_changed:seq:1" });

    expect(validateMainCandidate({
      candidate,
      laneId: "main:OTHER",
      stateView: appended,
      modelProfileVersion: "profile:1",
    })).toMatchObject({ valid: false, reason: "wrong_lane" });
    expect(validateMainCandidate({
      candidate: { ...candidate, policyVersion: 2 },
      laneId: manager.laneId,
      stateView: appended,
      modelProfileVersion: "profile:1",
    })).toMatchObject({ valid: false, reason: "policy_version_changed" });
    expect(validateMainCandidate({
      candidate,
      laneId: manager.laneId,
      stateView: appended,
      modelProfileVersion: "profile:2",
    })).toMatchObject({ valid: false, reason: "model_profile_changed" });
    expect(validateMainCandidate({
      candidate: { ...candidate, requiredExactEvidenceRefs: ["evidence:missing"] },
      laneId: manager.laneId,
      stateView: appended,
      modelProfileVersion: "profile:1",
    })).toMatchObject({ valid: false, reason: "missing_required_ref:evidence:missing" });
    const wrongRun = structuredClone(appended);
    wrongRun.context.current.runId = "RUN-OTHER";
    expect(validateMainCandidate({
      candidate,
      laneId: manager.laneId,
      stateView: wrongRun,
      modelProfileVersion: "profile:1",
    })).toMatchObject({ valid: false, reason: "missing_required_ref:run:RUN-1" });
  });

  it("mounts focus only for covered material while preserving exact authority and hot calls", () => {
    const state = promptState();
    state.context.run!.toolCalls![0]!.evidenceRef = "evidence:step-1";
    state.context.run!.toolCalls![1] = toolCall(2, "failed");
    const summary = focusSummary();
    const overlay = {
      candidateId: "CTX-1",
      summary,
      coveredSourceRefs: ["seq:1", "seq:2", "step:1", "call:call-1", "step:2", "call:call-2"],
      canonicalSourceHashes: {},
    };

    const projected = applyMainFocusOverlay(state, overlay);
    expect(projected.context.temporal.recent.map((event) => event.seq)).toEqual([3]);
    expect(projected.context.temporal.recent.filter((event) => event.current)).toHaveLength(1);
    expect(projected.context.run?.workState).toEqual(state.context.run?.workState);
    expect(projected.context.run?.focus).toEqual(summary);
    expect(projected.context.run?.toolCalls?.map((call) => call.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(projected.context.run?.toolCalls?.find((call) => call.step === 1)?.evidenceRef).toBe("evidence:step-1");
    expect(projected.context.run?.toolCalls?.find((call) => call.step === 2)?.status).toBe("failed");
    expect(JSON.stringify(projected).match(/CURRENT/g)).toHaveLength(1);
  });

});

function promptState(): AgentPromptStateView {
  return {
    context: {
      temporal: {
        recent: [
          { kind: "user", seq: 1, timestamp: "2026-07-20T00:00:00.000Z", content: "Earlier request" },
          { kind: "assistant", seq: 2, timestamp: "2026-07-20T00:00:01.000Z", content: "Earlier response" },
          { kind: "user", seq: 3, timestamp: "2026-07-20T00:00:02.000Z", content: "CURRENT", current: true },
        ],
      },
      current: {
        inputSeq: 3,
        runId: "RUN-1",
        routing: { status: "bound", workstreamId: "W-1", requestId: "R-1" },
      },
      stream: { agentId: "local", scopeKey: "default", recentWork: [] },
      work: { candidates: [] },
      resources: { stream: [], ingress: [], activeWorkstream: [] },
      observations: { revision: "obs:1", inventory: [], discovery: [], evidence: [] },
      run: {
        workState: {
          status: "not_done",
          summary: "Continue safely.",
          blockers: ["Exact blocker"],
          evidence: ["evidence:authoritative"],
          artifacts: ["artifact.txt"],
        },
        toolCalls: Array.from({ length: 8 }, (_, index) => toolCall(index + 1)),
      },
    },
  };
}

function toolCall(step: number, status: "success" | "failed" = "success") {
  return {
    step,
    callId: `call-${step}`,
    tool: "read_files",
    input: { path: `file-${step}.txt` },
    status,
    mode: "full" as const,
    ...(status === "success"
      ? { output: `result-${step}`, stepRef: { step, callId: `call-${step}` } }
      : { error: `failure-${step}` }),
  };
}

function focusSummary(input: { importantRefs?: string[] } = {}): RunFocusSummary {
  return {
    schemaVersion: 1,
    coveredMessageRange: { fromSeq: 1, toSeq: 2 },
    coveredStepRange: { fromStep: 1, toStep: 2 },
    goal: "Continue the current run.",
    constraints: [],
    decisions: [],
    completedWork: [],
    importantFindings: [{ text: "Earlier context remains relevant.", refs: input.importantRefs ?? ["seq:1"] }],
    artifacts: [],
    unresolvedQuestions: [],
    references: ["seq:1"],
  };
}

function assistant(summary: RunFocusSummary, tokenUsage?: LlmTokenUsage): LlmTurnOutput {
  return { type: "assistant", content: JSON.stringify(summary), ...(tokenUsage ? { usage: tokenUsage } : {}) };
}

function usage(inputTokens: number, outputTokens: number, cachedInputTokens?: number): LlmTokenUsage {
  return {
    provider: "test",
    model: "test-model",
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    exact: true,
  };
}

function provider(generateTurn: LlmProvider["generateTurn"]): LlmProvider {
  return {
    name: "test",
    version: "test-model",
    capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true, jsonSchema: true } },
    start() {},
    stop() {},
    generateTurn,
  };
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
