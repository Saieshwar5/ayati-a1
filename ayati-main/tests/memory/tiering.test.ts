import { describe, expect, it } from "vitest";
import {
  scoreToTier,
  shouldCloseSession,
  refreshTier,
  createInitialTierState,
  computeActivityScoreFromTimeline,
} from "../../src/memory/tiering.js";

describe("tiering", () => {
  describe("scoreToTier", () => {
    it("returns high for scores >= 40", () => {
      expect(scoreToTier(40)).toBe("high");
      expect(scoreToTier(100)).toBe("high");
    });

    it("returns medium for scores >= 20", () => {
      expect(scoreToTier(20)).toBe("medium");
      expect(scoreToTier(39)).toBe("medium");
    });

    it("returns low for scores >= 8", () => {
      expect(scoreToTier(8)).toBe("low");
      expect(scoreToTier(19)).toBe("low");
    });

    it("returns rare for scores < 8", () => {
      expect(scoreToTier(0)).toBe("rare");
      expect(scoreToTier(7)).toBe("rare");
    });
  });

  describe("shouldCloseSession", () => {
    it("returns true when idle timeout exceeded", () => {
      const result = shouldCloseSession(
        {
          startedAt: "2026-02-08T08:00:00.000Z",
          lastActivityAt: "2026-02-08T08:00:00.000Z",
          hardCapMinutes: 1440,
          idleTimeoutMinutes: 180,
        },
        "2026-02-08T11:01:00.000Z",
      );
      expect(result).toBe(true);
    });

    it("returns true when hard cap exceeded", () => {
      const result = shouldCloseSession(
        {
          startedAt: "2026-02-08T00:00:00.000Z",
          lastActivityAt: "2026-02-09T00:00:00.000Z",
          hardCapMinutes: 180,
          idleTimeoutMinutes: 1440,
        },
        "2026-02-08T03:01:00.000Z",
      );
      expect(result).toBe(true);
    });

    it("returns false when session is still valid", () => {
      const result = shouldCloseSession(
        {
          startedAt: "2026-02-08T08:00:00.000Z",
          lastActivityAt: "2026-02-08T08:30:00.000Z",
          hardCapMinutes: 1440,
          idleTimeoutMinutes: 180,
        },
        "2026-02-08T09:00:00.000Z",
      );
      expect(result).toBe(false);
    });
  });

  describe("refreshTier", () => {
    it("does not change tier when desired matches current", () => {
      const state = createInitialTierState("rare");
      const result = refreshTier(state, 5);
      expect(result.changed).toBe(false);
      expect(result.newState.tier).toBe("rare");
    });

    it("requires hysteresis hits before changing tier", () => {
      const state = createInitialTierState("rare");
      const first = refreshTier(state, 25);
      expect(first.changed).toBe(false);
      expect(first.newState.candidateTier).toBe("medium");
      expect(first.newState.candidateHits).toBe(1);

      const second = refreshTier(first.newState, 25);
      expect(second.changed).toBe(true);
      expect(second.newState.tier).toBe("medium");
    });

    it("resets candidate when desired tier changes", () => {
      const state = createInitialTierState("rare");
      const first = refreshTier(state, 25);
      expect(first.newState.candidateTier).toBe("medium");

      const second = refreshTier(first.newState, 45);
      expect(second.newState.candidateTier).toBe("high");
      expect(second.newState.candidateHits).toBe(1);
    });
  });

  describe("computeActivityScoreFromTimeline", () => {
    it("scores recent activity correctly", () => {
      const now = "2026-02-08T09:00:00.000Z";
      const timeline = [
        { type: "user_message", ts: "2026-02-08T08:30:00.000Z", tokenEstimate: 10 },
        { type: "assistant_message", ts: "2026-02-08T08:31:00.000Z", tokenEstimate: 50 },
        { type: "tool_call", ts: "2026-02-08T08:31:30.000Z" },
      ];

      const score = computeActivityScoreFromTimeline(timeline, now);
      expect(score).toBeGreaterThan(0);
      expect(score).toBe(3 * 1 + 2 * 1 + 4 * 1 + (10 + 50) / 1500);
    });

    it("ignores events older than 1 hour", () => {
      const now = "2026-02-08T10:00:00.000Z";
      const timeline = [
        { type: "user_message", ts: "2026-02-08T08:30:00.000Z", tokenEstimate: 100 },
      ];

      const score = computeActivityScoreFromTimeline(timeline, now);
      expect(score).toBe(0);
    });
  });
});
