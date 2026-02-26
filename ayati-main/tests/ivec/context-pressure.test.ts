import { describe, it, expect } from "vitest";
import { computeContextPressure, buildAutoRotateHandoff } from "../../src/ivec/context-pressure.js";
import type { ConversationTurn } from "../../src/memory/types.js";

describe("computeContextPressure", () => {
  it("returns 'none' below 50%", () => {
    expect(computeContextPressure(0).level).toBe("none");
    expect(computeContextPressure(25).level).toBe("none");
    expect(computeContextPressure(49).level).toBe("none");
    expect(computeContextPressure(49).message).toBe("");
  });

  it("returns 'info' at 50-69%", () => {
    expect(computeContextPressure(50).level).toBe("info");
    expect(computeContextPressure(60).level).toBe("info");
    expect(computeContextPressure(69).level).toBe("info");
    expect(computeContextPressure(50).message).toContain("moderate");
  });

  it("returns 'warning' at 70-84%", () => {
    expect(computeContextPressure(70).level).toBe("warning");
    expect(computeContextPressure(80).level).toBe("warning");
    expect(computeContextPressure(84).level).toBe("warning");
    expect(computeContextPressure(70).message).toContain("wrapping up");
  });

  it("returns 'critical' at 85-94%", () => {
    expect(computeContextPressure(85).level).toBe("critical");
    expect(computeContextPressure(90).level).toBe("critical");
    expect(computeContextPressure(94).level).toBe("critical");
    expect(computeContextPressure(85).message).toContain("MUST rotate");
  });

  it("returns 'auto_rotate' at 95%+", () => {
    expect(computeContextPressure(95).level).toBe("auto_rotate");
    expect(computeContextPressure(100).level).toBe("auto_rotate");
    expect(computeContextPressure(95).message).toContain("Auto-rotating");
  });

  it("handles boundary values precisely", () => {
    expect(computeContextPressure(49.9).level).toBe("none");
    expect(computeContextPressure(69.9).level).toBe("info");
    expect(computeContextPressure(84.9).level).toBe("warning");
    expect(computeContextPressure(94.9).level).toBe("critical");
  });
});

describe("buildAutoRotateHandoff", () => {
  const makeTurn = (role: "user" | "assistant", content: string): ConversationTurn => ({
    role,
    content,
    timestamp: new Date().toISOString(),
    sessionPath: "test/path",
  });

  it("includes context percentage", () => {
    const result = buildAutoRotateHandoff([], 95, "");
    expect(result).toContain("Auto-rotated at 95% context");
  });

  it("includes last 5 turns only", () => {
    const turns = Array.from({ length: 8 }, (_, i) =>
      makeTurn(i % 2 === 0 ? "user" : "assistant", `message ${i}`),
    );
    const result = buildAutoRotateHandoff(turns, 96, "");
    expect(result).toContain("[user]: message 4");
    expect(result).not.toContain("message 0");
    expect(result).not.toContain("message 2");
  });

  it("truncates long turn content at 200 chars", () => {
    const longContent = "x".repeat(300);
    const turns = [makeTurn("user", longContent)];
    const result = buildAutoRotateHandoff(turns, 95, "");
    expect(result).toContain("...");
    expect(result.length).toBeLessThanOrEqual(1000);
  });

  it("includes previous summary when provided", () => {
    const result = buildAutoRotateHandoff([], 95, "Previous work summary");
    expect(result).toContain("Previous session summary: Previous work summary");
  });

  it("caps total output at 1000 chars", () => {
    const turns = Array.from({ length: 5 }, () =>
      makeTurn("user", "a".repeat(200)),
    );
    const result = buildAutoRotateHandoff(turns, 95, "b".repeat(500));
    expect(result.length).toBeLessThanOrEqual(1000);
  });
});
