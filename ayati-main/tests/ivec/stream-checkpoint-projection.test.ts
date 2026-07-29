import { describe, expect, it } from "vitest";
import type {
  ContextCheckpointPlan,
  ContextCheckpointRecord,
  StreamMessage,
} from "ayati-context-engine";
import type { AgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import { buildCommittedStreamCheckpointTurnInput } from "../../src/ivec/agent-runner/stream-checkpoint-projection.js";
import { buildCoreCapsule } from "../../src/ivec/agent-runner/core-capsule.js";
import { emptyHotContextProjection } from "../../src/ivec/hot-context/index.js";

const AT = "2026-07-19T10:00:00.000Z";

describe("agent-stream checkpoint projection", () => {
  it("keeps a committed checkpoint separate from the exact later tail", () => {
    const stateView = baseStateView();
    stateView.context.core = buildCoreCapsule({
      revision: "context:test",
      runId: "RUN-1",
      timeline: [
      { kind: "user", seq: 1, timestamp: AT, content: "Earlier request" },
      { kind: "assistant", seq: 2, timestamp: AT, content: "Earlier response" },
      { kind: "user", seq: 3, timestamp: AT, content: "Current request", current: true },
      ],
      routing: { status: "unbound" },
      activeDocuments: [{
        name: "current-source.md",
        path: "/workspace/current-source.md",
        lastReadAt: "2026-07-19T09:59:00.000Z",
        evidenceRef: "run:RUN-OLD:step:2:call:read-source",
        freshness: "unchecked",
      }],
    });
    stateView.context.run!.contextPressure = {
      mode: "tool_compact",
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
    expect(promptState.context.core.continuity.checkpoint).toMatchObject({
      coveredFromSeq: 1,
      coveredToSeq: 2,
      exactAnchors: [1, 2],
      summary: { narrative: "Earlier continuity was compressed." },
    });
    expect(promptState.context.core.current.input).toEqual({
      kind: "user",
      seq: 3,
      timestamp: AT,
      content: "Current request",
      attachmentRefs: [{
        resourceId: "RES-0123456789ABCDEF01234567",
        kind: "document",
        displayName: "current-source.md",
      }],
      current: true,
    });
    expect(promptState.context.core.continuity.recentExact).toEqual([]);
    expect(promptState.context.core.current.activeDocuments).toEqual([{
      name: "current-source.md",
      path: "/workspace/current-source.md",
      lastReadAt: "2026-07-19T09:59:00.000Z",
      evidenceRef: "run:RUN-OLD:step:2:call:read-source",
      freshness: "unchecked",
    }]);
    expect(promptState.context.run?.contextPressure).toMatchObject({
      mode: "stream_checkpoint",
      unresolvedPressureStreak: 2,
    });
    expect(promptState.context.run?.workspaceRoot).toBe("/opt/ayati/runtime/workspace");
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
      core: buildCoreCapsule({
        revision: "context:test",
        runId: "RUN-1",
        timeline: [current],
        routing: { status: "unbound" },
      }),
      hot: emptyHotContextProjection(),
      run: {
        workspaceRoot: "/opt/ayati/runtime/workspace",
        workState: {
          status: "in_progress",
          summary: "Run-local work remains exact.",
          plan: [],
          importantContext: [],
        },
        toolCalls: [],
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
    exactTail: [message(3, "user", "Current request", {
      attachmentRefs: [{
        resourceId: "RES-0123456789ABCDEF01234567",
        kind: "document",
        displayName: "current-source.md",
      }],
    })],
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
  metadata: Pick<
    StreamMessage,
    "responseKind" | "feedbackKind" | "attachmentRefs"
  > = {},
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
    ...(metadata.responseKind ? { responseKind: metadata.responseKind } : {}),
    ...(metadata.feedbackKind ? { feedbackKind: metadata.feedbackKind } : {}),
    ...(metadata.attachmentRefs ? { attachmentRefs: metadata.attachmentRefs } : {}),
  };
}
