import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/prompt/builder.js";
import { emptySoulContext, emptyUserProfileContext } from "../../src/context/types.js";

describe("buildSystemPrompt", () => {
  it("assembles deterministic section order and metadata", () => {
    const soul = emptySoulContext();
    soul.soul.name = "CustomName";
    soul.soul.identity = "Identity text";

    const profile = emptyUserProfileContext();
    profile.name = "Sai";

    const output = buildSystemPrompt({
      basePrompt: "Base rules",
      soul,
      userProfile: profile,
      conversationTurns: [
        { role: "user", content: "A", timestamp: "t1", sessionPath: "s/p" },
        { role: "assistant", content: "B", timestamp: "t2", sessionPath: "s/p" },
      ],
      previousSessionSummary: "Session summary",
      activeSessionPath: "sessions/s-123.md",
      recentRunLedgers: [
        {
          timestamp: "2026-02-16T00:00:00.000Z",
          runId: "run-1",
          runPath: "data/runs/run-1",
          state: "completed",
          status: "completed",
          summary: "Finished task successfully",
        },
      ],
      skillBlocks: [{ id: "skill-1", content: "Do X" }],
    });

    expect(output.systemPrompt).toMatch(/^# Base System Prompt/);
    const soulPos = output.systemPrompt.indexOf("# Soul");
    const profilePos = output.systemPrompt.indexOf("# User Profile");
    const conversationPos = output.systemPrompt.indexOf("# Previous Conversation");
    const memoryPos = output.systemPrompt.indexOf("# Memory");
    const currentSessionPos = output.systemPrompt.indexOf("# Current Session");
    const recentRunsPos = output.systemPrompt.indexOf("# Recent Runs");
    const skillsPos = output.systemPrompt.indexOf("# Skills");

    expect(soulPos).toBeGreaterThan(0);
    expect(profilePos).toBeGreaterThan(soulPos);
    expect(conversationPos).toBeGreaterThan(profilePos);
    expect(memoryPos).toBeGreaterThan(conversationPos);
    expect(currentSessionPos).toBeGreaterThan(memoryPos);
    expect(recentRunsPos).toBeGreaterThan(currentSessionPos);
    expect(skillsPos).toBeGreaterThan(recentRunsPos);
    expect(output.systemPrompt).toContain("[t1]");
    expect(output.systemPrompt).toContain("[t2]");
    expect(output.systemPrompt).toContain("Name: CustomName");
    expect(output.systemPrompt).toContain("Session summary");
    expect(output.systemPrompt).toContain("session_path: sessions/s-123.md");
    expect(output.systemPrompt).toContain("runId=run-1");

    expect(output.sections.map((s) => s.id)).toEqual([
      "base",
      "soul",
      "user_profile",
      "conversation",
      "memory",
      "current_session",
      "recent_runs",
      "skills",
      "tools",
      "session_status",
    ]);
    const emptyOptionalIds = new Set(["tools", "session_status"]);
    const includedSections = output.sections.filter((s) => !emptyOptionalIds.has(s.id));
    expect(includedSections.every((s) => s.included)).toBe(true);
    const toolsSection = output.sections.find((s) => s.id === "tools");
    expect(toolsSection?.included).toBe(false);
    const statusSection = output.sections.find((s) => s.id === "session_status");
    expect(statusSection?.included).toBe(false);
  });

  it("memory section renders previous session summary only", () => {
    const output = buildSystemPrompt({
      basePrompt: "Base rules",
      soul: emptySoulContext(),
      userProfile: emptyUserProfileContext(),
      previousSessionSummary: "Last session: completed auth migration.",
    });

    expect(output.systemPrompt).toContain("## Previous Session Summary");
    expect(output.systemPrompt).toContain("Last session: completed auth migration.");
    expect(output.systemPrompt).not.toContain("## Reasoning History");
    expect(output.systemPrompt).not.toContain("## Tool History");
    expect(output.systemPrompt).not.toContain("## Recalled Context Evidence");
  });

  it("marks empty layers as not included", () => {
    const output = buildSystemPrompt({
      basePrompt: "Base rules",
      soul: emptySoulContext(),
      userProfile: emptyUserProfileContext(),
      conversationTurns: [],
      previousSessionSummary: "",
      skillBlocks: [],
    });

    const conversation = output.sections.find((s) => s.id === "conversation");
    const memory = output.sections.find((s) => s.id === "memory");
    const skills = output.sections.find((s) => s.id === "skills");

    expect(conversation?.included).toBe(false);
    expect(memory?.included).toBe(false);
    expect(skills?.included).toBe(false);
  });
});
