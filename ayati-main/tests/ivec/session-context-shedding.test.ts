import { describe, expect, it } from "vitest";
import type { ContextSessionTaskRunCheckpoint } from "../../src/context-engine/index.js";
import {
  buildSessionContextSheddingCandidate,
  shedSessionContext,
} from "../../src/ivec/agent-runner/session-context-shedding.js";
import type { AgentStateView } from "../../src/ivec/agent-runner/state-view.js";

describe("session context shedding", () => {
  it("retains only durable session metadata, attachments, and the latest checkpoint", () => {
    const checkpoints = Array.from({ length: 5 }, (_, index) => checkpoint(index + 1));
    const session: NonNullable<AgentStateView["context"]["git"]>["session"] = {
      meta: { sessionId: "session-1", assetCount: 2 },
      summary: { text: "Large session snapshot.", coveredUntilSeq: 8 },
      recentTaskRuns: checkpoints,
      attachments: { count: 2, recent: [{ sessionAssetId: "asset-1" }] },
      activity: {
        recent: [{
          seq: 10,
          type: "run_committed",
          at: "2026-07-10T10:00:00.000Z",
          runId: "run-5",
          workId: "work-5",
          commit: "commit-5",
        }],
      },
    };

    expect(shedSessionContext(session)).toEqual({
      meta: session.meta,
      recentTaskRuns: [checkpoints[4]],
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
    expect(projected.context.git?.session.recentTaskRuns?.map((item) => item.runId)).toEqual(["run-5"]);
    expect(projected.context.git?.session.activity.recent).toEqual([]);
    expect(projected.context.git?.session.attachments).toEqual(
      stateView.context.git?.session.attachments,
    );
    expect(projected.context.timeline).toEqual(stateView.context.timeline);
    expect(projected.context.git?.current.task).toEqual(stateView.context.git?.current.task);
    expect(projected.context.run?.workState).toEqual(stateView.context.run?.workState);
    expect(candidate.receipt).toMatchObject({
      triggered: true,
      removedSummary: true,
      removedCheckpointCount: 4,
      retainedCheckpointId: "checkpoint-5",
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
        content: "Continue the task.",
        current: true,
      }],
      git: {
        session: {
          meta: { sessionId: "session-1", assetCount: 1 },
          summary: { text: "Session snapshot.", coveredUntilSeq: 8 },
          recentTaskRuns: Array.from({ length: 5 }, (_, index) => checkpoint(index + 1)),
          attachments: { count: 1, recent: [] },
          activity: {
            recent: [{
              seq: 10,
              type: "run_committed",
              at: "2026-07-10T10:00:00.000Z",
              runId: "run-5",
              workId: "work-5",
              commit: "commit-5",
            }],
          },
        },
        current: {
          focus: { status: "active", ref: "refs/heads/task/work-5", workId: "work-5" },
          task: {
            identity: { ref: "refs/heads/task/work-5", title: "Task", objective: "Finish it." },
            state: { status: "active", completed: [], open: ["Finish it."], blockers: [], facts: [] },
            assets: [],
            activity: { recentRuns: [], recentEvidence: [] },
          },
        },
      },
      run: {
        workState: { status: "not_done", openWork: ["Finish it."], nextStep: "Continue." },
      },
    },
  };
}

function checkpoint(sequence: number): ContextSessionTaskRunCheckpoint {
  const fromSeq = sequence * 2 - 1;
  return {
    checkpointId: `checkpoint-${sequence}`,
    commit: `commit-${sequence}`,
    workId: `work-${sequence}`,
    runId: `run-${sequence}`,
    status: "completed",
    fromSeq,
    toSeq: fromSeq + 1,
    sourceHash: String(sequence).repeat(64),
    strategy: "llm",
    at: `2026-07-10T09:0${sequence}:00.000Z`,
    summary: `Task-run checkpoint ${sequence}.`,
  };
}
