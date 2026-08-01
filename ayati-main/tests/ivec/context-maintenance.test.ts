import { describe, expect, it, vi } from "vitest";
import { buildCoreCapsule } from "../../src/ivec/agent-runner/core-capsule.js";
import {
  planContextMaintenance,
  protectedConversationTailStart,
} from "../../src/ivec/context-preparation/context-maintenance.js";

const AT = "2026-08-01T10:00:00.000Z";

describe("conversation context maintenance", () => {
  it("protects the complete recent exact turn and summarizes only the older prefix", async () => {
    const core = buildCoreCapsule({
      revision: "core:pressure",
      runId: "RUN-3",
      continuityMaxTokens: 300,
      timeline: [
        { kind: "user", seq: 1, timestamp: AT, content: "old " + "x".repeat(4_000) },
        { kind: "assistant", seq: 2, timestamp: AT, content: "old answer " + "y".repeat(4_000) },
        { kind: "user", seq: 3, timestamp: AT, content: "recent question" },
        { kind: "assistant", seq: 4, timestamp: AT, content: "recent answer" },
        { kind: "user", seq: 5, timestamp: AT, content: "current question", current: true },
      ],
      routing: { status: "unbound" },
    });
    expect(core.continuity.maintenanceRequired).toBe(true);
    expect(core.continuity.recentExact.map((event) => event.seq)).toEqual([3, 4]);
    expect(protectedConversationTailStart(core)).toBe(3);

    const plan = vi.fn().mockResolvedValue({
      planId: "PLAN-1",
      streamId: "S-1",
      selectedMessages: [],
      exactTail: [],
      coveredFromSeq: 1,
      coveredToSeq: 2,
      sourceHash: "sha256:source",
      estimatedCheckpointTokens: 1_200,
      triggered: true,
    });
    const maintenance = await planContextMaintenance({
      stateView: {
        context: {
          core,
          hot: {
            available: [],
            loaded: [],
            budget: { maxMountedTokens: 8_000, mountedTokens: 0 },
          },
        },
      },
      contextCheckpoint: {
        plan,
        commit: vi.fn(),
        currentContext: vi.fn(),
      },
    });

    expect(plan).toHaveBeenCalledWith({
      protectFromSeq: 3,
      requiredSavingsTokens: 1,
      estimatedCheckpointTokens: 1_200,
    });
    expect(maintenance).toMatchObject({
      reason: "continuity_budget",
      protectFromSeq: 3,
      unloadedRanges: [{ fromSeq: 1, toSeq: 2 }],
    });
  });
});
