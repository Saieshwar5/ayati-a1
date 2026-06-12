import { describe, expect, it } from "vitest";
import { renderSessionStatusSection } from "../../../src/prompt/sections/session-status.js";

describe("renderSessionStatusSection", () => {
  it("returns empty string for null status", () => {
    expect(renderSessionStatusSection(null)).toBe("");
  });

  it("renders daily session metadata", () => {
    const result = renderSessionStatusSection({
      sessionId: "s1",
      sessionDate: "2026-06-12",
      activeSessionPath: "sessions/2026-06-12/s1.jsonl",
      contextPercent: 0,
      turns: 6,
      sessionAgeMinutes: 12,
      startedAt: "2026-06-12T09:00:00.000Z",
      handoffPhase: "inactive",
      pendingRotationReason: null,
    });

    expect(result).toContain("# Session Status");
    expect(result).toContain("session_id: s1");
    expect(result).toContain("session_date: 2026-06-12");
    expect(result).toContain("session_path: sessions/2026-06-12/s1.jsonl");
    expect(result).toContain("turns: 6");
    expect(result).toContain("session_age: 12m");
    expect(result).not.toContain("context_usage");
    expect(result).not.toContain("handoff_state");
  });
});
