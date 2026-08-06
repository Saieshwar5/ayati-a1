import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultLlmRuntimeConfig,
  getActiveProvider,
  getLlmRuntimeConfig,
  getConfiguredModelContextLimits,
  getModelForProvider,
  initializeLlmRuntimeConfig,
  resetLlmRuntimeConfigForTests,
  setActiveProvider,
  setModelContextLimitsForProvider,
  setModelForProvider,
} from "../../src/config/llm-runtime-config.js";

describe("llm runtime config", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    resetLlmRuntimeConfigForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates the default config file when it is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "runtime", "llm-config.json");

    const config = await initializeLlmRuntimeConfig({ configPath });

    expect(config).toEqual(createDefaultLlmRuntimeConfig());

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved).toEqual(createDefaultLlmRuntimeConfig());
  });

  it("persists provider and model changes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "llm-config.json");

    await initializeLlmRuntimeConfig({ configPath });
    await setActiveProvider("openai");
    await setModelForProvider("openai", "gpt-5-mini");

    expect(getActiveProvider()).toBe("openai");
    expect(getModelForProvider("openai")).toBe("gpt-5-mini");
    expect(getLlmRuntimeConfig()).toEqual({
      activeProvider: "openai",
      models: {
        openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
        openai: "gpt-5-mini",
        anthropic: "claude-sonnet-4-5-20250929",
        fireworks: "fireworks/minimax-m2p5",
      },
      modelContextLimits: {},
    });

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.activeProvider).toBe("openai");
    expect(saved.models.openai).toBe("gpt-5-mini");
  });

  it("persists context limits for the configured provider model", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "llm-config.json");

    await initializeLlmRuntimeConfig({ configPath });
    await setModelForProvider("anthropic", "claude-large-context");
    await setModelContextLimitsForProvider("anthropic", {
      contextWindowTokens: 200_000,
      maxInputTokens: 180_000,
      outputReserveTokens: 12_000,
      preparationInputTokens: 80_000,
      recoveryTargetTokens: 90_000,
      softInputTokens: 110_000,
      hardInputTokens: 150_000,
    });

    expect(getConfiguredModelContextLimits("anthropic")).toEqual({
      contextWindowTokens: 200_000,
      maxInputTokens: 180_000,
      outputReserveTokens: 12_000,
      preparationInputTokens: 80_000,
      recoveryTargetTokens: 90_000,
      softInputTokens: 110_000,
      hardInputTokens: 150_000,
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.modelContextLimits["anthropic:claude-large-context"]).toEqual({
      contextWindowTokens: 200_000,
      maxInputTokens: 180_000,
      outputReserveTokens: 12_000,
      preparationInputTokens: 80_000,
      recoveryTargetTokens: 90_000,
      softInputTokens: 110_000,
      hardInputTokens: 150_000,
    });
  });

  it("rejects configured context windows below 128K", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "llm-config.json");

    await initializeLlmRuntimeConfig({ configPath });

    await expect(setModelContextLimitsForProvider("openai", {
      contextWindowTokens: 64_000,
    })).rejects.toThrow("contextWindowTokens must be at least 128000");
  });

  it("rejects an invalid context pressure threshold order", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "llm-config.json");

    await initializeLlmRuntimeConfig({ configPath });

    await expect(setModelContextLimitsForProvider("openai", {
      contextWindowTokens: 128_000,
      recoveryTargetTokens: 75_000,
      softInputTokens: 70_000,
      hardInputTokens: 100_000,
    })).rejects.toThrow("recoveryTargetTokens must be smaller than softInputTokens");
  });

  it("rejects a preparation trigger at or above recovery", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "llm-config.json");

    await initializeLlmRuntimeConfig({ configPath });

    await expect(setModelContextLimitsForProvider("openai", {
      contextWindowTokens: 128_000,
      preparationInputTokens: 60_000,
      recoveryTargetTokens: 60_000,
      softInputTokens: 70_000,
      hardInputTokens: 100_000,
    })).rejects.toThrow("preparationInputTokens must be smaller than recoveryTargetTokens");
  });

  it("normalizes old configs with context-limit defaults", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "llm-config.json");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          activeProvider: "fireworks",
          models: {
            openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
            openai: "gpt-4o-mini",
            anthropic: "claude-sonnet-4-5-20250929",
            fireworks: "fireworks/minimax-m2p7",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = await initializeLlmRuntimeConfig({ configPath });

    expect(config.modelContextLimits).toEqual({});

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.modelContextLimits).toEqual({});
  });

  it("throws when the config file contains invalid JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "llm-config.json");

    await writeFile(configPath, "{invalid", "utf8");

    await expect(initializeLlmRuntimeConfig({ configPath })).rejects.toThrow(
      `Invalid JSON in LLM runtime config at "${configPath}".`,
    );
  });

  it("throws when the config contains an unsupported active provider", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "llm-config.json");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          activeProvider: "gemini",
          models: {
            openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
            openai: "gpt-4o-mini",
            anthropic: "claude-sonnet-4-5-20250929",
            fireworks: "fireworks/minimax-m2p5",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(initializeLlmRuntimeConfig({ configPath })).rejects.toThrow(
      'Invalid LLM runtime config: unsupported activeProvider "gemini".',
    );
  });
});
