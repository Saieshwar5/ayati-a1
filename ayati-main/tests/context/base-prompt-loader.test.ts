import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../src/shared/index.js", () => ({
  devWarn: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { devWarn } from "../../src/shared/index.js";

async function getLoader() {
  const mod = await import("../../src/context/loaders/base-prompt-loader.js");
  return mod.loadBasePrompt;
}

describe("loadBasePrompt", () => {
  const mockReadFile = vi.mocked(readFile);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads non-empty system_prompt.md", async () => {
    mockReadFile.mockResolvedValue("  Hello base prompt  ");

    const loadBasePrompt = await getLoader();
    await expect(loadBasePrompt()).resolves.toBe("Hello base prompt");
  });

  it("uses fallback if file missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const loadBasePrompt = await getLoader();
    const result = await loadBasePrompt();

    expect(result).toBe("Be clear, honest, concise, and never fabricate details.");
    expect(devWarn).toHaveBeenCalledWith("Base system prompt missing or empty. Using fallback base prompt.");
  });
});
