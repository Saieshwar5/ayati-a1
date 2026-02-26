import { describe, it, expect } from "vitest";
import { renderSessionStatusSection } from "../../../src/prompt/sections/session-status.js";

describe("renderSessionStatusSection", () => {
  it("returns empty string for null status", () => {
    expect(renderSessionStatusSection(null)).toBe("");
  });

  it("renders correct markdown for valid status", () => {
    const result = renderSessionStatusSection({
      contextPercent: 42,
      turns: 10,
      sessionAgeMinutes: 5,
    });

    expect(result).toContain("# Session Status");
    expect(result).toContain("context_usage: 42%");
    expect(result).toContain("turns: 10");
    expect(result).toContain("session_age: 5m");
  });

  it("includes pressure message when context is high", () => {
    const result = renderSessionStatusSection({
      contextPercent: 87,
      turns: 20,
      sessionAgeMinutes: 15,
    });

    expect(result).toContain("CRITICAL");
    expect(result).toContain("MUST rotate");
  });

  it("does not include pressure message below 50%", () => {
    const result = renderSessionStatusSection({
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
      contextPercent: 55.7,
      turns: 6,
      sessionAgeMinutes: 3,
    });

    expect(result).toContain("context_usage: 56%");
  });
});
