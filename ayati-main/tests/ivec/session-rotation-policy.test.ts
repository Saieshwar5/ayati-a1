import { describe, expect, it } from "vitest";
import {
  evaluateSessionRotation,
  getLogicalDayKey,
  resolveRotationTimezone,
  shouldPrepareSessionHandoff,
  shouldRotateSessionForContext,
} from "../../src/ivec/session-rotation-policy.js";

describe("session rotation policy", () => {
  it("starts handoff preparation at 50%", () => {
    expect(shouldPrepareSessionHandoff(49)).toBe(false);
    expect(shouldPrepareSessionHandoff(50)).toBe(true);
  });

  it("marks rotation at 70%", () => {
    expect(shouldRotateSessionForContext(69)).toBe(false);
    expect(shouldRotateSessionForContext(70)).toBe(true);
  });

  it("uses the fallback timezone when profile timezone is missing", () => {
    expect(resolveRotationTimezone(null)).toBe("Asia/Kolkata");
    expect(resolveRotationTimezone("")).toBe("Asia/Kolkata");
  });

  it("computes logical day key with a 1 AM cutover", () => {
    const beforeCutover = new Date("2026-04-16T00:30:00+05:30");
    const afterCutover = new Date("2026-04-16T01:30:00+05:30");

    expect(getLogicalDayKey(beforeCutover, "Asia/Kolkata")).toBe("2026-04-15");
    expect(getLogicalDayKey(afterCutover, "Asia/Kolkata")).toBe("2026-04-16");
  });

  it("rotates on daily cutover when the logical day changed", () => {
    const result = evaluateSessionRotation({
      now: new Date("2026-04-16T01:05:00+05:30"),
      contextPercent: 10,
      sessionStartedAt: new Date("2026-04-15T10:00:00+05:30").toISOString(),
      timezone: "Asia/Kolkata",
    });

    expect(result.rotate).toBe(true);
    expect(result.reason).toBe("daily_cutover");
  });

  it("does not rotate before the 1 AM cutover when still in the same logical day", () => {
    const result = evaluateSessionRotation({
      now: new Date("2026-04-16T00:45:00+05:30"),
      contextPercent: 10,
      sessionStartedAt: new Date("2026-04-15T10:00:00+05:30").toISOString(),
      timezone: "Asia/Kolkata",
    });

    expect(result.rotate).toBe(false);
    expect(result.currentDayKey).toBe("2026-04-15");
  });

  it("rotates for a pending context threshold", () => {
    const result = evaluateSessionRotation({
      now: new Date("2026-04-16T14:00:00+05:30"),
      contextPercent: 55,
      sessionStartedAt: new Date("2026-04-16T08:00:00+05:30").toISOString(),
      timezone: "Asia/Kolkata",
      pendingRotationReason: "context_threshold",
    });

    expect(result.rotate).toBe(true);
    expect(result.reason).toBe("context_threshold");
  });

  it("rotates immediately when restored session is already above the context threshold", () => {
    const result = evaluateSessionRotation({
      now: new Date("2026-04-16T14:00:00+05:30"),
      contextPercent: 74,
      sessionStartedAt: new Date("2026-04-16T08:00:00+05:30").toISOString(),
      timezone: "Asia/Kolkata",
    });

    expect(result.rotate).toBe(true);
    expect(result.reason).toBe("context_threshold");
  });

  it("prefers daily cutover over context rotation when both are true", () => {
    const result = evaluateSessionRotation({
      now: new Date("2026-04-17T01:10:00+05:30"),
      contextPercent: 80,
      sessionStartedAt: new Date("2026-04-16T09:00:00+05:30").toISOString(),
      timezone: "Asia/Kolkata",
      pendingRotationReason: "context_threshold",
    });

    expect(result.rotate).toBe(true);
    expect(result.reason).toBe("daily_cutover");
  });
});
