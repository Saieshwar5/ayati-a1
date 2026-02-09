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
      conversationWindow: { maxTurns: 1, maxChars: 10 },
      skillBlocks: [{ id: "skill-1", content: "Do X" }],
    });

    expect(output.systemPrompt).toMatch(/^# Base System Prompt/);
    const soulPos = output.systemPrompt.indexOf("# Soul");
    const profilePos = output.systemPrompt.indexOf("# User Profile");
    const conversationPos = output.systemPrompt.indexOf("# Previous Conversation");
    const skillsPos = output.systemPrompt.indexOf("# Skills");

    expect(soulPos).toBeGreaterThan(0);
    expect(profilePos).toBeGreaterThan(soulPos);
    expect(conversationPos).toBeGreaterThan(profilePos);
    expect(skillsPos).toBeGreaterThan(conversationPos);
    expect(output.systemPrompt).toContain("[t2] assistant: B");
    expect(output.systemPrompt).not.toContain("[t1] user: A");
    expect(output.systemPrompt).toContain("Name: CustomName");

    expect(output.sections.map((s) => s.id)).toEqual([
      "base",
      "soul",
      "user_profile",
      "conversation",
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
      skillBlocks: [],
    });

    const conversation = output.sections.find((s) => s.id === "conversation");
    const skills = output.sections.find((s) => s.id === "skills");

    expect(conversation?.included).toBe(false);
    expect(skills?.included).toBe(false);
  });
});
