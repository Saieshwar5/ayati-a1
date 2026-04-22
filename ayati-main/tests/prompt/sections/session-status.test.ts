import { describe, it, expect } from "vitest";
import { renderSessionStatusSection } from "../../../src/prompt/sections/session-status.js";

describe("renderSessionStatusSection", () => {
  const baseStatus = {
    startedAt: "2026-04-16T00:00:00.000Z",
    handoffPhase: "inactive" as const,
    pendingRotationReason: null,
  };

  it("returns empty string for null status", () => {
    expect(renderSessionStatusSection(null)).toBe("");
  });

  it("renders correct markdown for valid status", () => {
    const result = renderSessionStatusSection({
      ...baseStatus,
      contextPercent: 42,
      turns: 10,
      sessionAgeMinutes: 5,
    });

    expect(result).toContain("# Session Status");
    expect(result).toContain("context_usage: 42%");
    expect(result).toContain("turns: 10");
    expect(result).toContain("session_age: 5m");
    expect(result).toContain("handoff_state: inactive");
    expect(result).toContain("rotation_pending: none");
  });

  it("includes pressure message when context is high", () => {
    const result = renderSessionStatusSection({
      ...baseStatus,
      contextPercent: 87,
      turns: 20,
      sessionAgeMinutes: 15,
      handoffPhase: "finalized",
      pendingRotationReason: "context_threshold",
    });

    expect(result).toContain("CRITICAL");
    expect(result).toContain("Automatic rotation is pending");
    expect(result).toContain("rotation_pending: context_threshold");
  });

  it("does not include pressure message below 50%", () => {
    const result = renderSessionStatusSection({
      ...baseStatus,
      contextPercent: 30,
      turns: 4,
      sessionAgeMinutes: 2,
    });

    expect(result).toContain("# Session Status");
    expect(result).not.toContain("INFO");
    expect(result).not.toContain("WARNING");
    expect(result).not.toContain("CRITICAL");
  });

  it("rounds context percent", () => {
    const result = renderSessionStatusSection({
      ...baseStatus,
      contextPercent: 55.7,
      turns: 6,
      sessionAgeMinutes: 3,
      handoffPhase: "preparing",
    });

    expect(result).toContain("context_usage: 56%");
  });
});
