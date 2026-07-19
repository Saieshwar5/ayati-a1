import { describe, expect, it } from "vitest";
import type { ContextSessionRunCheckpoint } from "../../src/context-engine/index.js";
import {
  buildSessionContextSheddingCandidate,
  shedSessionContext,
} from "../../src/ivec/agent-runner/session-context-shedding.js";
import type { AgentStateView } from "../../src/ivec/agent-runner/state-view.js";

describe("session context shedding", () => {
  it("retains only durable session metadata, attachments, and the latest checkpoint", () => {
    const checkpoints = Array.from({ length: 5 }, (_, index) => checkpoint(index + 1));
    const session: NonNullable<AgentStateView["context"]["git"]>["session"] = {
      meta: { sessionId: "session-1", resourceCount: 2 },
      summary: { text: "Large session snapshot.", coveredUntilSeq: 8 },
      recentRunCheckpoints: checkpoints,
      recentCommits: Array.from({ length: 5 }, (_, index) => sessionCommit(5 - index)),
      attachments: { count: 2, recent: [{ sessionAssetId: "asset-1" }] },
      activity: {
        recent: [{
          seq: 10,
          type: "workstream_context_committed",
          at: "2026-07-10T10:00:00.000Z",
          runId: "run-5",
          workstreamId: "W-5",
          commit: "commit-5",
        }],
      },
    };

    expect(shedSessionContext(session)).toEqual({
      meta: session.meta,
      recentCommits: [sessionCommit(5)],
      recentRunCheckpoints: [checkpoints[4]],
      attachments: session.attachments,
      activity: { recent: [] },
    });
  });

  it("builds an immutable prompt-only candidate and preserves protected run context", () => {
    const stateView = stateWithSession();
    const sourceBefore = structuredClone(stateView);
    const candidate = buildSessionContextSheddingCandidate({
      stateView,
      turnInput: {
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "original" },
        ],
      },
      buildPrompt: (projected) => JSON.stringify(projected),
    });

    const prompt = candidate.turnInput.messages.find((message) => message.role === "user")?.content;
    if (typeof prompt !== "string") throw new Error("Expected a projected prompt.");
    const projected = JSON.parse(prompt) as AgentStateView;

    expect(stateView).toEqual(sourceBefore);
    expect(projected.context.git?.session).not.toHaveProperty("summary");
    expect(projected.context.git?.session.recentRunCheckpoints?.map((item) => item.checkpointId)).toEqual(["checkpoint-5"]);
    expect(projected.context.git?.session.recentCommits?.map((item) => item.commit)).toEqual(["commit-5"]);
    expect(JSON.stringify(projected.context)).not.toContain('"runId"');
    expect(projected.context.git?.session.activity.recent).toEqual([]);
    expect(projected.context.git?.session.attachments).toEqual(
      stateView.context.git?.session.attachments,
    );
    expect(projected.context.timeline).toEqual(stateView.context.timeline);
    expect(projected.context.git?.current.workstream).toEqual(stateView.context.git?.current.workstream);
    expect(projected.context.run?.workState).toEqual(stateView.context.run?.workState);
    expect(candidate.receipt).toMatchObject({
      triggered: true,
      removedSummary: true,
      removedCheckpointCount: 4,
      retainedCheckpointId: "checkpoint-5",
      removedRecentCommitCount: 4,
      retainedRecentCommit: "commit-5",
      removedActivityCount: 1,
    });
  });
});

function stateWithSession(): AgentStateView {
  return {
    context: {
      timeline: [{
        kind: "user",
        seq: 11,
        timestamp: "2026-07-10T10:01:00.000Z",
        content: "Continue the workstream.",
        current: true,
      }],
      git: {
        session: {
          meta: { sessionId: "session-1", resourceCount: 1 },
          summary: { text: "Session snapshot.", coveredUntilSeq: 8 },
          recentRunCheckpoints: Array.from({ length: 5 }, (_, index) => checkpoint(index + 1)),
          recentCommits: Array.from({ length: 5 }, (_, index) => sessionCommit(5 - index)),
          attachments: { count: 1, recent: [] },
          activity: {
            recent: [{
              seq: 10,
              type: "workstream_context_committed",
              at: "2026-07-10T10:00:00.000Z",
              runId: "run-5",
              workstreamId: "W-5",
              commit: "commit-5",
            }],
          },
        },
        current: {
          focus: { status: "active", ref: "refs/heads/main", workstreamId: "W-5" },
          workstream: {
            identity: {
              ref: "refs/heads/main",
              workstreamId: "W-5",
              title: "Learning plan",
              objective: "Continue learning across days.",
            },
            state: {
              summary: "Learning remains in progress.",
              workstreamStatus: "in_progress",
              lifecycleStatus: "active",
              repositoryHealth: "ready",
              blockers: [],
              next: "Continue the next lesson.",
            },
            resources: [],
            activity: { recentCommits: [] },
          },
        },
      },
      run: {
        workState: { status: "not_done", openWork: ["Finish it."], nextStep: "Continue." },
      },
    },
  };
}

function sessionCommit(index: number) {
  return {
    commit: "commit-" + index,
    subject: "session: workstream progress " + index,
    summary: "Workstream progress " + index,
    runId: "run-" + index,
    workstreamId: "W-" + index,
  };
}

function checkpoint(sequence: number): ContextSessionRunCheckpoint {
  const fromSeq = sequence * 2 - 1;
  return {
    checkpointId: `checkpoint-${sequence}`,
    commit: `commit-${sequence}`,
    workstreamId: `W-${sequence}`,
    runId: `run-${sequence}`,
    status: "completed",
    fromSeq,
    toSeq: fromSeq + 1,
    sourceHash: String(sequence).repeat(64),
    strategy: "llm",
    at: `2026-07-10T09:0${sequence}:00.000Z`,
    summary: `Workstream-bound run checkpoint ${sequence}.`,
  };
}
