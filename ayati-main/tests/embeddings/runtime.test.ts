import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeLlmRuntimeConfig,
  resetLlmRuntimeConfigForTests,
  setEmbeddingModelForProvider,
} from "../../src/config/llm-runtime-config.js";
import type { EmbeddingProvider } from "../../src/embeddings/contracts.js";

const mockEmbeddingProvider: EmbeddingProvider = {
  name: "openai",
  modelName: "mock-embedding-model",
  start: vi.fn(),
  stop: vi.fn(),
  embed: vi.fn(async (text: string) => [text.length]),
  embedBatch: vi.fn(async (texts: string[]) => texts.map((text) => [text.length])),
};

vi.mock("../../src/embeddings/openai/index.js", () => ({
  default: mockEmbeddingProvider,
}));

describe("embedding runtime provider", () => {
  let tempDir = "";
  let runtimeProvider: EmbeddingProvider | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "ayati-embedding-runtime-"));
    await initializeLlmRuntimeConfig({ configPath: join(tempDir, "llm-config.json") });
    await setEmbeddingModelForProvider("openai", "text-embedding-3-large");
    runtimeProvider = null;
  });

  afterEach(async () => {
    await runtimeProvider?.stop();
    resetLlmRuntimeConfigForTests();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("starts the configured embedding provider and delegates embedding calls", async () => {
    const mod = await import("../../src/embeddings/runtime/index.js");
    runtimeProvider = mod.default;

    await runtimeProvider.start();
    const vectors = await runtimeProvider.embedBatch(["alpha", "beta"]);

    expect(runtimeProvider.name).toBe("openai");
    expect(mockEmbeddingProvider.start).toHaveBeenCalledTimes(1);
    expect(mockEmbeddingProvider.embedBatch).toHaveBeenCalledWith(["alpha", "beta"]);
    expect(vectors).toEqual([[5], [4]]);
  });
});
