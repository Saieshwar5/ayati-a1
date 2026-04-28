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

  it("builds system prompt from base + soul", async () => {
    const systemPromptMd = "Keep answers practical.";
    const soulJson = JSON.stringify({
      version: 3,
      identity: {
        name: "MyAgent",
        role: "General-purpose autonomous AI teammate",
        responsibility: "Help the user complete useful work.",
      },
      behavior: {
        traits: ["curious"],
        working_style: ["verify important facts"],
        communication: ["warm and direct"],
      },
      boundaries: ["do not invent facts"],
    });
    mockReadFile.mockImplementation(async (filePath) => {
      const path = String(filePath);
      if (path.endsWith("system_prompt.md")) return systemPromptMd;
      if (path.endsWith("soul.json")) return soulJson;
      throw new Error("Unexpected file");
    });

    const loadContext = await getLoadContext();
    const result = await loadContext();

    expect(result).toContain("# Base System Prompt");
    expect(result).toContain("# Soul");
    expect(result).not.toContain("# User Profile");
    expect(result).toContain("Name: MyAgent");
    expect(result).toContain("Role: General-purpose autonomous AI teammate");
    expect(result).toContain("Responsibility: Help the user complete useful work.");
  }, 20000);

  it("falls back when files are missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const loadContext = await getLoadContext();
    const result = await loadContext();

    expect(result).toContain("# Base System Prompt");
    expect(result).toContain("Be clear, honest, concise, and never fabricate details.");
    expect(devWarn).toHaveBeenCalledWith("Base system prompt missing or empty. Using fallback base prompt.");
    expect(devWarn).toHaveBeenCalledWith("Soul context missing or invalid. Using empty soul context.");
  });
});
