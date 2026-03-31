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
  const mod = await import("../../src/context/loaders/controller-prompts-loader.js");
  return mod.loadControllerPrompts;
}

describe("loadControllerPrompts", () => {
  const mockReadFile = vi.mocked(readFile);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads non-empty controller prompt files", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      const path = String(filePath);
      if (path.endsWith("context/controller/understand.md")) return "  understand instructions  ";
      if (path.endsWith("context/controller/direct.md")) return "  direct instructions  ";
      if (path.endsWith("context/controller/reeval.md")) return "  reeval instructions  ";
      if (path.endsWith("context/controller/system-event.md")) return "  system event instructions  ";
      throw new Error("Unexpected file");
    });

    const loadControllerPrompts = await getLoader();
    await expect(loadControllerPrompts()).resolves.toEqual({
      understand: "understand instructions",
      direct: "direct instructions",
      reeval: "reeval instructions",
      systemEvent: "system event instructions",
    });
  });

  it("returns empty strings when controller prompt files are missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const loadControllerPrompts = await getLoader();
    const result = await loadControllerPrompts();

    expect(result).toEqual({
      understand: "",
      direct: "",
      reeval: "",
      systemEvent: "",
    });
    expect(devWarn).toHaveBeenCalledWith(
      "Controller prompt missing or empty. Using built-in fallback for: controller/understand.md",
    );
    expect(devWarn).toHaveBeenCalledWith(
      "Controller prompt missing or empty. Using built-in fallback for: controller/direct.md",
    );
    expect(devWarn).toHaveBeenCalledWith(
      "Controller prompt missing or empty. Using built-in fallback for: controller/reeval.md",
    );
    expect(devWarn).toHaveBeenCalledWith(
      "Controller prompt missing or empty. Using built-in fallback for: controller/system-event.md",
    );
  });
});
