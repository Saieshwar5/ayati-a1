import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeLlmRuntimeConfig,
  resetLlmRuntimeConfigForTests,
  setImageGenerationModelForProvider,
} from "../../src/config/llm-runtime-config.js";
import type { ImageGenerationProvider } from "../../src/image-generation/contracts.js";

const mockImageGenerationProvider: ImageGenerationProvider = {
  name: "openai",
  modelName: "mock-image-model",
  start: vi.fn(),
  stop: vi.fn(),
  generateImage: vi.fn(async () => ({
    model: "mock-image-model",
    mimeType: "image/png",
    base64: "ZmFrZQ==",
  })),
};

vi.mock("../../src/image-generation/openai/index.js", () => ({
  default: mockImageGenerationProvider,
}));

describe("image generation runtime provider", () => {
  let tempDir = "";
  let runtimeProvider: ImageGenerationProvider | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "ayati-image-runtime-"));
    await initializeLlmRuntimeConfig({ configPath: join(tempDir, "llm-config.json") });
    await setImageGenerationModelForProvider("openai", "gpt-image-2");
    runtimeProvider = null;
  });

  afterEach(async () => {
    await runtimeProvider?.stop();
    resetLlmRuntimeConfigForTests();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("starts the configured image provider and delegates image generation", async () => {
    const mod = await import("../../src/image-generation/runtime/index.js");
    runtimeProvider = mod.default;

    await runtimeProvider.start();
    const image = await runtimeProvider.generateImage({ prompt: "Generate a product icon" });

    expect(runtimeProvider.name).toBe("openai");
    expect(mockImageGenerationProvider.start).toHaveBeenCalledTimes(1);
    expect(mockImageGenerationProvider.generateImage).toHaveBeenCalledWith({
      prompt: "Generate a product icon",
    });
    expect(image).toEqual({
      model: "mock-image-model",
      mimeType: "image/png",
      base64: "ZmFrZQ==",
    });
  });
});
