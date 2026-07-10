import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeLlmRuntimeConfig,
  resetLlmRuntimeConfigForTests,
  setModelContextLimitsForProvider,
  setModelForProvider,
} from "../../src/config/llm-runtime-config.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import { resolveModelContextLimits } from "../../src/providers/shared/model-context-limits.js";

describe("model context limits", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    resetLlmRuntimeConfigForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uses a conservative 128K profile when no model override exists", () => {
    expect(resolveModelContextLimits(provider("custom"))).toEqual({
      provider: "custom",
      model: "custom",
      contextWindowTokens: 128_000,
      outputReserveTokens: 8_192,
      softInputTokens: 70_000,
      recoveryTargetTokens: 60_000,
      hardInputTokens: 100_000,
      source: "default_128k",
    });
  });

  it("resolves configured limits for a supported provider and model", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-model-limits-"));
    tempDirs.push(tempDir);
    await initializeLlmRuntimeConfig({ configPath: join(tempDir, "llm-config.json") });
    await setModelForProvider("openai", "large-context-model");
    await setModelContextLimitsForProvider("openai", {
      contextWindowTokens: 256_000,
      outputReserveTokens: 16_000,
    });

    expect(resolveModelContextLimits(provider("openai"))).toEqual({
      provider: "openai",
      model: "large-context-model",
      contextWindowTokens: 256_000,
      outputReserveTokens: 16_000,
      softInputTokens: 140_000,
      recoveryTargetTokens: 120_000,
      hardInputTokens: 200_000,
      source: "configured",
    });
  });

  it("scales pressure thresholds for larger model windows", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-model-limits-"));
    tempDirs.push(tempDir);
    await initializeLlmRuntimeConfig({ configPath: join(tempDir, "llm-config.json") });
    await setModelForProvider("openai", "one-million-context-model");
    await setModelContextLimitsForProvider("openai", {
      contextWindowTokens: 1_000_000,
    });

    expect(resolveModelContextLimits(provider("openai"))).toMatchObject({
      contextWindowTokens: 1_000_000,
      recoveryTargetTokens: 468_750,
      softInputTokens: 546_875,
      hardInputTokens: 781_250,
    });
  });
});

function provider(name: string): LlmProvider {
  return {
    name,
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start() {},
    stop() {},
    async generateTurn() {
      return { type: "assistant", content: "ok" };
    },
  };
}
