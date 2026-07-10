import { describe, expect, it } from "vitest";
import {
  buildGitMemorySessionProjection,
  renderGitMemoryCommitMessage,
  projectSessionAttachments,
  selectRecentTaskRunCheckpoints,
  type GitMemoryLogEntry,
} from "../../../src/context-engine/index.js";

describe("git-memory session context projection", () => {
  it("keeps the latest five valid task-run checkpoints in chronological order", () => {
    const entries = Array.from({ length: 7 }, (_, index) => checkpointEntry(7 - index));

    const checkpoints = selectRecentTaskRunCheckpoints({
      entries,
      sessionId: "S-20260710-local",
    });

    expect(checkpoints.map((checkpoint) => checkpoint.runId)).toEqual([
      "R-20260710-0003",
      "R-20260710-0004",
      "R-20260710-0005",
      "R-20260710-0006",
      "R-20260710-0007",
    ]);
    expect(checkpoints.map((checkpoint) => checkpoint.toSeq)).toEqual([6, 8, 10, 12, 14]);
  });

  it("uses the newest valid boundary and retains exact conversation after it", () => {
    const conversation = Array.from({ length: 15 }, (_, index) => ({
      seq: index + 1,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      at: `2026-07-10T09:00:${String(index).padStart(2, "0")}+05:30`,
      text: `message ${index + 1}`,
    }));
    const malformedNewest = {
      ...checkpointEntry(8),
      message: checkpointEntry(8).message.replace(/Ayati-Checkpoint-Source-Hash: [a-f0-9]+/, "Ayati-Checkpoint-Source-Hash: invalid"),
    };

    const projection = buildGitMemorySessionProjection({
      conversation,
      checkpointLog: [malformedNewest, checkpointEntry(6), checkpointEntry(4)],
      sessionId: "S-20260710-local",
      summary: { text: "Current session snapshot.", coveredUntilSeq: 12 },
      attachments: { count: 1, recent: [] },
    });

    expect(projection.recentTaskRuns.map((checkpoint) => checkpoint.runId)).toEqual([
      "R-20260710-0004",
      "R-20260710-0006",
    ]);
    expect(projection.openTimeline.map((record) => record.seq)).toEqual([13, 14, 15]);
    expect(projection.metrics).toMatchObject({
      latestConversationSeq: 15,
      checkpointBoundarySeq: 12,
      summaryTokens: expect.any(Number),
      checkpointTokens: expect.any(Number),
      timelineTokens: expect.any(Number),
      attachmentTokens: expect.any(Number),
    });
    expect(projection.metrics.totalSessionTokens).toBe(
      projection.metrics.summaryTokens
      + projection.metrics.checkpointTokens
      + projection.metrics.timelineTokens
      + projection.metrics.attachmentTokens,
    );
  });

  it("keeps the complete exact timeline when no valid checkpoint exists", () => {
    const conversation = [{
      seq: 1,
      role: "user" as const,
      at: "2026-07-10T09:00:00+05:30",
      text: "Start a session.",
    }];

    const projection = buildGitMemorySessionProjection({
      conversation,
      checkpointLog: [],
      sessionId: "S-20260710-local",
    });

    expect(projection.openTimeline).toEqual(conversation);
    expect(projection.recentTaskRuns).toEqual([]);
    expect(projection.metrics).not.toHaveProperty("checkpointBoundarySeq");
  });

  it("projects only the ten most recently used attachment records", () => {
    const projected = projectSessionAttachments({
      updatedAt: "2026-07-10T10:00:00+05:30",
      attachments: Array.from({ length: 12 }, (_, index) => ({
        sessionAssetId: `SA-${String(index + 1).padStart(2, "0")}`,
        kind: "document",
        name: `document-${index + 1}.pdf`,
        source: "upload",
        status: "ready" as const,
        createdAt: `2026-07-10T09:${String(index).padStart(2, "0")}:00+05:30`,
      })),
    });

    expect(projected.count).toBe(12);
    expect(projected.recent).toHaveLength(10);
    expect(projected.recent.map((attachment) => attachment.sessionAssetId)).toEqual([
      "SA-12", "SA-11", "SA-10", "SA-09", "SA-08",
      "SA-07", "SA-06", "SA-05", "SA-04", "SA-03",
    ]);
  });
});

function checkpointEntry(sequence: number): GitMemoryLogEntry {
  const fromSeq = sequence * 2 - 1;
  const toSeq = sequence * 2;
  const suffix = sequence.toString(16);
  return {
    commit: `commit-${sequence}`,
    message: renderGitMemoryCommitMessage({
      subject: `ayati: checkpoint task run R-20260710-${String(sequence).padStart(4, "0")}`,
      summary: `Session interval: completed task-run interval ${sequence}.`,
      notes: [`User request ${fromSeq}: request ${sequence}`],
      trailers: {
        sessionId: "S-20260710-local",
        taskId: `W-20260710-${String(sequence).padStart(4, "0")}`,
        runId: `R-20260710-${String(sequence).padStart(4, "0")}`,
        event: "task_run_checkpointed",
        status: "completed",
        at: `2026-07-10T09:${String(sequence).padStart(2, "0")}:00+05:30`,
        conversationSeq: { fromSeq, toSeq },
        schemaVersion: 1,
        extras: {
          "Checkpoint-Id": `task-run-checkpoint-${suffix.repeat(64).slice(0, 64)}`,
          "Checkpoint-Source-Hash": suffix.repeat(64).slice(0, 64),
          "Checkpoint-Strategy": sequence % 2 === 0 ? "llm" : "deterministic",
        },
      },
    }),
  };
}
