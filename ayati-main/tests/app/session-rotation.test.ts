import { describe, expect, it, vi } from "vitest";
import { rotateSessionBeforeRunIfNeeded } from "../../src/app/session-rotation.js";
import { noopSessionMemory } from "../../src/memory/provider.js";
import type { SessionMemory } from "../../src/memory/types.js";

describe("rotateSessionBeforeRunIfNeeded", () => {
  it("returns unsupported when session memory cannot create sessions", () => {
    const result = rotateSessionBeforeRunIfNeeded({
      clientId: "c1",
      sessionMemory: noopSessionMemory,
      now: () => new Date("2026-06-27T10:00:00.000Z"),
    });

    expect(result).toEqual({ rotated: false, reason: "unsupported" });
  });

  it("does nothing when rotation policy does not request a new session", () => {
    const createSession = vi.fn();
    const sessionMemory = {
      ...noopSessionMemory,
      createSession,
      getSessionStatus: () => ({
        sessionId: "s1",
        sessionDate: "2026-06-27",
        activeSessionPath: "sessions/2026-06-27/s1.jsonl",
        contextPercent: 10,
        turns: 2,
        sessionAgeMinutes: 3,
        startedAt: "2026-06-27T09:55:00.000Z",
        handoffPhase: "inactive" as const,
        pendingRotationReason: null,
      }),
    } satisfies SessionMemory;

    const result = rotateSessionBeforeRunIfNeeded({
      clientId: "c1",
      sessionMemory,
      now: () => new Date("2026-06-27T10:00:00.000Z"),
    });

    expect(result).toEqual({ rotated: false, reason: "not_needed" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("creates a new session when rotation policy requests rotation", () => {
    const createSession = vi.fn().mockReturnValue({
      previousSessionId: "s1",
      sessionId: "s2",
      sessionPath: "sessions/2026-06-27/s2.jsonl",
    });
    const sessionMemory = {
      ...noopSessionMemory,
      createSession,
      getSessionStatus: () => ({
        sessionId: "s1",
        sessionDate: "2026-06-27",
        activeSessionPath: "sessions/2026-06-27/s1.jsonl",
        contextPercent: 96,
        turns: 12,
        sessionAgeMinutes: 45,
        startedAt: "2026-06-27T09:00:00.000Z",
        handoffPhase: "finalized" as const,
        pendingRotationReason: "context_threshold" as const,
      }),
    } satisfies SessionMemory;

    const result = rotateSessionBeforeRunIfNeeded({
      clientId: "c1",
      sessionMemory,
      now: () => new Date("2026-06-27T10:00:00.000Z"),
    });

    expect(result).toEqual({
      rotated: true,
      reason: "context_threshold",
      contextPercent: 96,
    });
    expect(createSession).toHaveBeenCalledWith("c1", expect.objectContaining({
      reason: "context_threshold",
      source: "system",
      timezone: "Asia/Kolkata",
    }));
  });
});
