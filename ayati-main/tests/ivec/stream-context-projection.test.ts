import { describe, expect, it } from "vitest";
import type {
  ContextCheckpointPlan,
  ContextCheckpointRecord,
  ResourceRef,
  ReusableObservation,
  StreamMessage,
  WorkstreamCandidate,
} from "ayati-context-engine";
import type { AgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import { buildCommittedStreamCheckpointTurnInput } from "../../src/ivec/agent-runner/stream-checkpoint-projection.js";
import { buildStreamContextProjectionCandidate } from "../../src/ivec/agent-runner/stream-context-projection.js";

const AT = "2026-07-19T10:00:00.000Z";

describe("agent-stream context projection", () => {
  it("deterministically bounds slow continuity before requesting a checkpoint", () => {
    const stateView = baseStateView();
    stateView.context.stream.recentWork = Array.from({ length: 10 }, (_, index) => ({
      workstreamId: `W-202607${String(index + 1).padStart(2, "0")}-0001`,
      requestId: "R-0001",
      outcome: "done" as const,
      resourceIds: [],
      completedAt: `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
    }));
    stateView.context.work.candidates = Array.from({ length: 10 }, (_, index) => candidate(index));
    stateView.context.resources.stream = Array.from({ length: 15 }, (_, index) => resource(index));
    stateView.context.observations.inventory = Array.from({ length: 10 }, (_, index) => observation("inventory", index));
    stateView.context.observations.discovery = Array.from({ length: 10 }, (_, index) => observation("discovery", index));
    stateView.context.observations.evidence = Array.from({ length: 10 }, (_, index) => observation("evidence", index));
    const source = structuredClone(stateView);

    const projected = buildStreamContextProjectionCandidate({
      stateView,
      turnInput: {
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "unprojected" },
        ],
      },
      buildPrompt: (state) => JSON.stringify(state),
    });

    expect(projected.receipt).toMatchObject({
      schemaVersion: 1,
      triggered: true,
      removedCandidateCount: 5,
      removedRecentWorkCount: 4,
      removedResourceCount: 3,
      removedObservationCount: 6,
    });
    expect(projected.receipt.correctedLocalEstimateTokens).toBeGreaterThan(0);
    expect(stateView).toEqual(source);

    const promptState = projectedPrompt(projected.turnInput.messages);
    expect(promptState.context.stream.recentWork).toHaveLength(6);
    expect(promptState.context.work.candidates).toHaveLength(5);
    expect(promptState.context.resources.stream).toHaveLength(12);
    expect(promptState.context.observations.inventory).toHaveLength(8);
    expect(promptState.context.observations.discovery).toHaveLength(8);
    expect(promptState.context.observations.evidence).toHaveLength(8);
    expect(promptState.context.observations.evidence[0]?.observationId).toBe("OBS-evidence-2");
    expect(promptState.context.run?.workState?.summary).toBe("Run-local work remains exact.");
  });

  it("keeps a committed checkpoint separate from the exact later tail", () => {
    const stateView = baseStateView();
    stateView.context.temporal.recent = [
      { kind: "user", seq: 1, timestamp: AT, content: "Earlier request" },
      { kind: "assistant", seq: 2, timestamp: AT, content: "Earlier response" },
      { kind: "user", seq: 3, timestamp: AT, content: "Current request", current: true },
    ];
    stateView.context.current.inputSeq = 3;
    stateView.context.run!.contextPressure = {
      mode: "stream_project",
      recommendedMode: "stream_checkpoint",
      escalationReason: "repeated_unresolved_pressure",
      unresolvedPressureStreak: 2,
      compactedCalls: 0,
      recoverable: true,
    };
    const plan = checkpointPlan();
    const checkpoint = checkpointRecord();

    const turnInput = buildCommittedStreamCheckpointTurnInput({
      stateView,
      turnInput: {
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "unprojected" },
        ],
      },
      plan,
      checkpoint,
      buildPrompt: (state) => JSON.stringify(state),
    });

    const promptState = projectedPrompt(turnInput.messages);
    expect(promptState.context.temporal.checkpoint).toMatchObject({
      coveredFromSeq: 1,
      coveredToSeq: 2,
      exactAnchors: [1, 2],
      summary: { narrative: "Earlier continuity was compressed." },
    });
    expect(promptState.context.temporal.recent).toEqual([{
      kind: "user",
      seq: 3,
      timestamp: AT,
      content: "Current request",
      current: true,
    }]);
    expect(promptState.context.run?.contextPressure).toMatchObject({
      mode: "stream_checkpoint",
      unresolvedPressureStreak: 2,
    });
    expect(JSON.stringify(promptState)).not.toContain("sha256:checkpoint-source");
  });
});

interface ProjectedPromptState {
  context: AgentStateView["context"];
}

function projectedPrompt(messages: Array<{ role: string; content?: unknown }>): ProjectedPromptState {
  const user = messages.find((message) => message.role === "user")?.content;
  if (typeof user !== "string") throw new Error("Projected user prompt is missing.");
  return JSON.parse(user) as ProjectedPromptState;
}

function baseStateView(): AgentStateView {
  const current = {
    kind: "user" as const,
    seq: 3,
    timestamp: AT,
    content: "Current request",
    current: true as const,
  };
  return {
    context: {
      temporal: { recent: [current] },
      current: { inputSeq: current.seq, runId: "RUN-1", routing: { status: "unbound" } },
      stream: { agentId: "local", scopeKey: "default", recentWork: [] },
      work: { candidates: [] },
      resources: { stream: [], ingress: [], activeWorkstream: [] },
      observations: {
        revision: "observations:1",
        inventory: [],
        discovery: [],
        evidence: [],
      },
      run: {
        workState: {
          status: "not_done",
          summary: "Run-local work remains exact.",
          blockers: [],
          verifiedFacts: [],
        },
        toolCalls: [],
      },
    },
  };
}

function candidate(index: number): WorkstreamCandidate {
  return {
    workstreamId: `W-202606${String(index + 1).padStart(2, "0")}-0001`,
    title: `Candidate ${index}`,
    objective: "Candidate objective",
    status: "active",
    head: `head-${index}`,
    primaryResources: [],
    updatedAt: AT,
    discovery: { tier: "candidate", reasons: ["text_match"] },
    starred: false,
    boundRunsLast30Days: 0,
  };
}

function resource(index: number): ResourceRef {
  return {
    resourceId: `RES-${String(index).padStart(24, "0")}`,
    kind: "file",
    origin: "user_reference",
    displayName: `resource-${index}.txt`,
    description: "Fixture resource",
    aliases: [],
    locator: { kind: "filesystem", path: `/tmp/resource-${index}.txt` },
    version: { key: `sha256:${index}`, observedAt: AT, exists: true, kind: "file" },
    availability: "available",
    metadataStatus: "enriched",
    createdAt: AT,
    updatedAt: AT,
  };
}

function observation(kind: ReusableObservation["kind"], index: number): ReusableObservation {
  return {
    observationId: `OBS-${kind}-${index}`,
    streamId: "S-1",
    sourceRunId: "RUN-1",
    sourceStep: 1,
    sourceCallId: `${kind}-${index}`,
    kind,
    queryKey: `${kind}:${index}`,
    purpose: `Observe ${kind}`,
    preview: `${kind} result ${index}`,
    retention: kind === "evidence" ? "evidence_only" : "while_relevant",
    resources: [],
    createdAt: AT,
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
    exactTail: [message(3, "user", "Current request")],
    coveredFromSeq: 1,
    coveredToSeq: 2,
    sourceHash: "sha256:checkpoint-source",
    estimatedCheckpointTokens: 1_200,
    triggered: true,
  };
}

function checkpointRecord(): ContextCheckpointRecord {
  return {
    checkpointId: "CHK-1",
    streamId: "S-1",
    coveredFromSeq: 1,
    coveredToSeq: 2,
    sourceHash: "sha256:checkpoint-source",
    schemaVersion: 1,
    summary: {
      userRequests: [{ seq: 1, text: "Earlier request" }],
      constraints: [],
      decisions: [{ seq: 2, text: "Earlier response" }],
      corrections: [],
      importantFacts: [],
      unresolvedQuestions: [],
      references: [],
      narrative: "Earlier continuity was compressed.",
    },
    exactAnchors: [1, 2],
    tokenCount: 100,
    reason: "context_pressure",
    provider: "test-provider",
    model: "test-model",
    createdAt: AT,
  };
}

function message(
  sequence: number,
  role: StreamMessage["role"],
  content: string,
): StreamMessage {
  return {
    messageId: `M-${sequence}`,
    streamId: "S-1",
    runId: "RUN-1",
    sequence,
    role,
    content,
    contentHash: `sha256:${sequence}`,
    at: AT,
  };
}
