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
        { role: "user", content: "A", timestamp: "t1" },
        { role: "assistant", content: "B", timestamp: "t2" },
      ],
      previousSessionSummary: "Session summary",
      toolEvents: [
        {
          timestamp: "t3",
          toolName: "shell",
          status: "success",
          argsPreview: "{\"cmd\":\"pwd\"}",
          outputPreview: "/tmp",
        },
      ],
      skillBlocks: [{ id: "skill-1", content: "Do X" }],
    });

    expect(output.systemPrompt).toMatch(/^# Base System Prompt/);
    const soulPos = output.systemPrompt.indexOf("# Soul");
    const profilePos = output.systemPrompt.indexOf("# User Profile");
    const conversationPos = output.systemPrompt.indexOf("# Previous Conversation");
    const memoryPos = output.systemPrompt.indexOf("# Memory");
    const skillsPos = output.systemPrompt.indexOf("# Skills");

    expect(soulPos).toBeGreaterThan(0);
    expect(profilePos).toBeGreaterThan(soulPos);
    expect(conversationPos).toBeGreaterThan(profilePos);
    expect(memoryPos).toBeGreaterThan(conversationPos);
    expect(skillsPos).toBeGreaterThan(memoryPos);
    expect(output.systemPrompt).toContain("[t1] user: A");
    expect(output.systemPrompt).toContain("[t2] assistant: B");
    expect(output.systemPrompt).toContain("Name: CustomName");

    expect(output.sections.map((s) => s.id)).toEqual([
      "base",
      "soul",
      "user_profile",
      "conversation",
      "memory",
      "skills",
    ]);
    expect(output.sections.every((s) => s.included)).toBe(true);
  });

  it("marks empty layers as not included", () => {
    const output = buildSystemPrompt({
      basePrompt: "Base rules",
      soul: emptySoulContext(),
      userProfile: emptyUserProfileContext(),
      conversationTurns: [],
      previousSessionSummary: "",
      toolEvents: [],
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
