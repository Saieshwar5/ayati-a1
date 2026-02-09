import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../src/shared/index.js", () => ({
  devWarn: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { devWarn } from "../../src/shared/index.js";

async function getLoadContext() {
  const mod = await import("../../src/context/context-loader.js");
  return mod.loadContext;
}

describe("loadContext compatibility wrapper", () => {
  const mockReadFile = vi.mocked(readFile);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds system prompt from base + soul + user profile", async () => {
    const systemPromptMd = "Keep answers practical.";
    const soulJson = JSON.stringify({
      version: 2,
      soul: {
        name: "MyAgent",
        identity: "Identity text",
        personality: ["curious"],
        values: ["honesty"],
      },
      voice: {
        tone: ["warm"],
        style: ["direct"],
        quirks: [],
        never_do: [],
      },
    });
    const userProfileJson = JSON.stringify({
      name: "Sai",
      nickname: null,
      occupation: null,
      location: null,
      languages: ["English"],
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
        mood_baseline: "focused",
        stress_triggers: [],
        joy_triggers: [],
      },
      active_hours: null,
      last_updated: "2026-02-08T00:00:00.000Z",
    });

    mockReadFile.mockImplementation(async (filePath) => {
      const path = String(filePath);
      if (path.endsWith("system_prompt.md")) return systemPromptMd;
      if (path.endsWith("soul.json")) return soulJson;
      if (path.endsWith("user_profile.json")) return userProfileJson;
      throw new Error("Unexpected file");
    });

    const loadContext = await getLoadContext();
    const result = await loadContext();

    expect(result).toContain("# Base System Prompt");
    expect(result).toContain("# Soul");
    expect(result).toContain("# User Profile");
    expect(result).toContain("Name: MyAgent");
    expect(result).toContain("- Name: Sai");
  });

  it("falls back when files are missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const loadContext = await getLoadContext();
    const result = await loadContext();

    expect(result).toContain("# Base System Prompt");
    expect(result).toContain("Be clear, honest, concise, and never fabricate details.");
    expect(devWarn).toHaveBeenCalledWith("Base system prompt missing or empty. Using fallback base prompt.");
    expect(devWarn).toHaveBeenCalledWith("Soul context missing or invalid. Using empty soul context.");
    expect(devWarn).toHaveBeenCalledWith(
      "User profile context missing or invalid. Using empty user profile context.",
    );
  });
});
