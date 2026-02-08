import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../src/shared/index.js", () => ({
  devWarn: vi.fn(),
}));

import { readFile } from "node:fs/promises";

async function getLoader() {
  const mod = await import("../../src/context/load-system-prompt-input.js");
  return mod.loadSystemPromptInput;
}

describe("loadSystemPromptInput", () => {
  const mockReadFile = vi.mocked(readFile);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads base/soul/profile and resolves whitelisted skill blocks", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      const path = String(filePath);
      if (path.endsWith("system_prompt.md")) return "Base prompt";
      if (path.endsWith("skills_whitelist.json")) return '["skill-a"]';
      if (path.endsWith("soul.json")) {
        return JSON.stringify({
          version: 2,
          soul: { name: "CustomName", identity: "Identity", personality: [], values: [] },
          voice: { tone: [], style: [], quirks: [], never_do: [] },
        });
      }
      if (path.endsWith("user_profile.json")) {
        return JSON.stringify({
          name: null,
          nickname: null,
          occupation: null,
          location: null,
          languages: [],
          interests: [],
          facts: [],
          people: [],
          projects: [],
          communication: {
            formality: "balanced",
            verbosity: "balanced",
            humor_receptiveness: "medium",
            emoji_usage: "rare",
          },
          emotional_patterns: {
            mood_baseline: "unknown",
            stress_triggers: [],
            joy_triggers: [],
          },
          active_hours: null,
          last_updated: "2026-02-08T00:00:00.000Z",
        });
      }
      throw new Error("Unexpected file");
    });

    const loadSystemPromptInput = await getLoader();
    const result = await loadSystemPromptInput({
      memoryProvider: {
        getRecentTurns: vi.fn().mockResolvedValue([{ role: "user", content: "hi", timestamp: "t1" }]),
      },
      skillsProvider: {
        getEnabledSkills: vi.fn().mockResolvedValue([]),
        getEnabledSkillBlocks: vi
          .fn()
          .mockResolvedValue([{ id: "skill-a", content: "Use A" }]),
        getEnabledTools: vi.fn().mockResolvedValue([]),
      },
    });

    expect(result.basePrompt).toBe("Base prompt");
    expect(result.conversationTurns).toHaveLength(1);
    expect(result.skillBlocks).toEqual([{ id: "skill-a", content: "Use A" }]);
  });
});
