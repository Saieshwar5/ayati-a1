import { describe, expect, it } from "vitest";
import type { ContextCheckpointRecord } from "ayati-context-engine";
import type { AgentTemporalEvent } from "../../src/ivec/agent-runner/agent-context-events.js";
import {
  buildCoreCapsule,
  CORE_CAPSULE_CONTINUITY_MAX_TOKENS,
  replaceCoreCapsuleRecentExact,
} from "../../src/ivec/agent-runner/core-capsule.js";

const AT = "2026-07-24T10:00:00.000Z";

describe("Core Capsule", () => {
  it("uses an 8K default continuity budget before checkpoint maintenance", () => {
    const capsule = buildCoreCapsule({
      revision: "context:default-budget",
      runId: "RUN-DEFAULT-BUDGET",
      timeline: [
        user(1, "A".repeat(9_000)),
        assistant(2, "B".repeat(9_000)),
        user(3, "Recent request"),
        assistant(4, "Recent response"),
        user(5, "Current request", true),
      ],
    });

    expect(CORE_CAPSULE_CONTINUITY_MAX_TOKENS).toBe(8_000);
    expect(capsule.budget.continuityMaxTokens).toBe(8_000);
    expect(capsule.continuity.recentExact.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(capsule.continuity.maintenanceRequired).toBe(false);
  });

  it("projects the exact current input once and keeps routing exact", () => {
    const capsule = buildCoreCapsule({
      revision: "context:1",
      runId: "RUN-1",
      timeline: [
        user(1, "Earlier request"),
        assistant(2, "Earlier response"),
        user(3, "Current request", true),
      ],
      routing: {
        status: "bound",
        workstreamId: "W-20260724-0001",
        requestId: "R-0001",
      },
    });

    expect(capsule.current).toMatchObject({
      runId: "RUN-1",
      input: { seq: 3, content: "Current request", current: true },
      routing: {
        status: "bound",
        workstreamId: "W-20260724-0001",
        requestId: "R-0001",
      },
    });
    expect(capsule.continuity.recentExact.map((event) => event.seq)).toEqual([1, 2]);
    expect(JSON.stringify(capsule).match(/Current request/g)).toHaveLength(1);
  });

  it("keeps at most five lightweight active-document pointers across projections", () => {
    const capsule = buildCoreCapsule({
      revision: "context:documents",
      runId: "RUN-DOCUMENTS",
      timeline: [user(1, "Continue with the same document.", true)],
      activeDocuments: Array.from({ length: 7 }, (_, index) => ({
        name: `file-${index + 1}.txt`,
        path: `/workspace/file-${index + 1}.txt`,
        lastReadAt: AT,
        evidenceRef: `run:RUN-${index + 1}:step:1:call:read`,
        freshness: "unchecked" as const,
      })),
    });
    const projected = replaceCoreCapsuleRecentExact(capsule, []);

    expect(capsule.current.activeDocuments).toHaveLength(5);
    expect(capsule.current.activeDocuments?.[0]).toEqual({
      name: "file-1.txt",
      path: "/workspace/file-1.txt",
      lastReadAt: AT,
      evidenceRef: "run:RUN-1:step:1:call:read",
      freshness: "unchecked",
    });
    expect(projected.current.activeDocuments)
      .toEqual(capsule.current.activeDocuments);
  });

  it("bounds historical continuity by complete turns and exposes omitted ranges", () => {
    const capsule = buildCoreCapsule({
      revision: "context:2",
      runId: "RUN-2",
      continuityMaxTokens: 260,
      timeline: [
        user(1, "A".repeat(500)),
        assistant(2, "B".repeat(500)),
        user(3, "Small recent request"),
        assistant(4, "Small recent response"),
        user(5, "Current request", true),
      ],
    });

    expect(capsule.continuity.recentExact.map((event) => event.seq)).toEqual([3, 4]);
    expect(capsule.continuity.unloadedRanges).toEqual([{
      fromSeq: 1,
      toSeq: 2,
      eventCount: 2,
      sourceRef: "seq:1-2",
      reason: "continuity_budget",
    }]);
    expect(capsule.continuity.maintenanceRequired).toBe(true);
    expect(capsule.budget.estimatedContinuityTokens).toBeLessThanOrEqual(260);
  });

  it("keeps the newest complete turn exact when that turn exceeds the continuity target", () => {
    const capsule = buildCoreCapsule({
      revision: "context:3",
      runId: "RUN-3",
      continuityMaxTokens: 160,
      timeline: [
        user(1, "Choose an owner. ".repeat(80)),
        assistant(2, "Should I create a new workstream? ".repeat(80)),
        user(3, "Create a new one.", true),
      ],
    });

    expect(capsule.continuity.recentExact.map((event) => event.seq)).toEqual([1, 2]);
    expect(capsule.continuity.unloadedRanges).toEqual([]);
    expect(capsule.continuity.maintenanceRequired).toBe(false);
    expect(capsule.budget.estimatedContinuityTokens).toBeGreaterThan(160);
  });

  it("keeps the newest completed system-event turn exact", () => {
    const capsule = buildCoreCapsule({
      revision: "context:system-event",
      runId: "RUN-SYSTEM",
      continuityMaxTokens: 180,
      timeline: [
        user(1, "Older request ".repeat(80)),
        assistant(2, "Older response ".repeat(80)),
        systemEvent(3, "A scheduled import completed."),
        assistant(4, "The import completed successfully."),
        user(5, "What changed?", true),
      ],
    });

    expect(capsule.continuity.recentExact.map((event) => event.seq)).toEqual([3, 4]);
    expect(capsule.continuity.unloadedRanges).toEqual([{
      fromSeq: 1,
      toSeq: 2,
      eventCount: 2,
      sourceRef: "seq:1-2",
      reason: "continuity_budget",
    }]);
  });

  it("keeps current-input size outside the historical continuity budget", () => {
    const common = {
      revision: "context:4",
      runId: "RUN-4",
      checkpoint: checkpoint(),
    };
    const small = buildCoreCapsule({
      ...common,
      timeline: [user(5, "small", true)],
    });
    const large = buildCoreCapsule({
      ...common,
      timeline: [user(5, "X".repeat(40_000), true)],
    });

    expect(large.budget).toEqual(small.budget);
    expect(large.current.input).toMatchObject({ content: "X".repeat(40_000) });
    expect(large.continuity.checkpoint).toMatchObject({
      coveredFromSeq: 1,
      coveredToSeq: 4,
    });
    expect(large.continuity.checkpoint).not.toHaveProperty("checkpointId");
    expect(large.continuity.checkpoint).not.toHaveProperty("sourceHash");
  });

  it("fails closed unless exactly one current input is present", () => {
    expect(() => buildCoreCapsule({
      revision: "context:5",
      runId: "RUN-5",
      timeline: [user(1, "not current")],
    })).toThrow("CURRENT_INPUT_CONTEXT_MISMATCH");

    expect(() => buildCoreCapsule({
      revision: "context:6",
      runId: "RUN-6",
      timeline: [user(1, "first", true), user(2, "second", true)],
    })).toThrow("CURRENT_INPUT_CONTEXT_MISMATCH");
  });

  it("remeasures the capsule when a pressure projection replaces exact history", () => {
    const capsule = buildCoreCapsule({
      revision: "context:7",
      runId: "RUN-7",
      timeline: [
        user(1, "Older exact request"),
        assistant(2, "Older exact response"),
        user(3, "Current request", true),
      ],
    });
    const projected = replaceCoreCapsuleRecentExact(capsule, []);

    expect(projected.continuity.recentExact).toEqual([]);
    expect(projected.budget.estimatedContinuityTokens)
      .toBeLessThan(capsule.budget.estimatedContinuityTokens);
    expect(projected.current).toEqual(capsule.current);
  });
});

function user(seq: number, content: string, current = false): AgentTemporalEvent {
  return {
    kind: "user",
    seq,
    timestamp: AT,
    content,
    ...(current ? { current: true } : {}),
  };
}

function assistant(seq: number, content: string): AgentTemporalEvent {
  return {
    kind: "assistant",
    seq,
    timestamp: AT,
    content,
  };
}

function systemEvent(seq: number, summary: string): AgentTemporalEvent {
  return {
    kind: "system_event",
    seq,
    timestamp: AT,
    source: "scheduler",
    event: "import.completed",
    summary,
  };
}

function checkpoint(): ContextCheckpointRecord {
  return {
    checkpointId: "CHK-1",
    streamId: "S-1",
    coveredFromSeq: 1,
    coveredToSeq: 4,
    sourceHash: "hash",
    schemaVersion: 1,
    summary: {
      userRequests: [{ seq: 1, text: "Keep the current request exact." }],
      constraints: [],
      decisions: [],
      corrections: [],
      importantFacts: [],
      unresolvedQuestions: [],
      references: [],
      narrative: "Older continuity.",
    },
    exactAnchors: [1],
    tokenCount: 100,
    reason: "context_pressure",
    provider: "test",
    model: "test",
    createdAt: AT,
  };
}
