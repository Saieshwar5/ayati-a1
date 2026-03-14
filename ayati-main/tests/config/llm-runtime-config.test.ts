import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultLlmRuntimeConfig,
  getActiveProvider,
  getLlmRuntimeConfig,
  getModelForProvider,
  initializeLlmRuntimeConfig,
  resetLlmRuntimeConfigForTests,
  setActiveProvider,
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
    });

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.activeProvider).toBe("openai");
    expect(saved.models.openai).toBe("gpt-5-mini");
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
