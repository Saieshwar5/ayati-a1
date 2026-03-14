import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import {
  resetLlmRuntimeConfigForTests,
  setActiveProvider,
} from "../../src/config/llm-runtime-config.js";
import {
  type ProviderRuntimeConfigHandle,
  setupProviderRuntimeConfig,
} from "./runtime-config-test-helpers.js";

function createMockProvider(name: string, reply: string): LlmProvider {
  return {
    name,
    version: "1.0.0",
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: {
        jsonObject: true,
        jsonSchema: true,
      },
    },
    start: vi.fn(),
    stop: vi.fn(),
    countInputTokens: vi.fn().mockResolvedValue({
      provider: name,
      model: `${name}-model`,
      inputTokens: 42,
      exact: false,
    }),
    generateTurn: vi.fn<() => Promise<LlmTurnOutput>>().mockResolvedValue({
      type: "assistant",
      content: reply,
    }),
  };
}

vi.mock("../../src/providers/openai/index.js", () => ({
  default: createMockProvider("openai", "hi from openai"),
}));

vi.mock("../../src/providers/anthropic/index.js", () => ({
  default: createMockProvider("anthropic", "hi from anthropic"),
}));

describe("runtime provider", () => {
  let runtimeConfig: ProviderRuntimeConfigHandle;
  let runtimeProvider: LlmProvider | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeConfig = await setupProviderRuntimeConfig("openai", "gpt-4o");
    runtimeProvider = null;
  });

  afterEach(async () => {
    await runtimeProvider?.stop();
    await runtimeConfig.cleanup();
    resetLlmRuntimeConfigForTests();
  });

  it("starts the currently active provider", async () => {
    const mod = await import("../../src/providers/runtime/index.js");
    runtimeProvider = mod.default;

    await runtimeProvider.start();
    const reply = await runtimeProvider.generateTurn({
      messages: [{ role: "user", content: "hello" }],
    });

    const openAiProvider = (await import("../../src/providers/openai/index.js")).default;

    expect(runtimeProvider.name).toBe("openai");
    expect(openAiProvider.start).toHaveBeenCalledTimes(1);
    expect(openAiProvider.generateTurn).toHaveBeenCalledTimes(1);
    expect(reply).toEqual({ type: "assistant", content: "hi from openai" });
  });

  it("switches to a different provider after config changes", async () => {
    const mod = await import("../../src/providers/runtime/index.js");
    runtimeProvider = mod.default;

    await runtimeProvider.start();
    await runtimeProvider.generateTurn({
      messages: [{ role: "user", content: "hello" }],
    });

    await setActiveProvider("anthropic");

    const reply = await runtimeProvider.generateTurn({
      messages: [{ role: "user", content: "hello again" }],
    });

    const openAiProvider = (await import("../../src/providers/openai/index.js")).default;
    const anthropicProvider = (await import("../../src/providers/anthropic/index.js")).default;

    expect(openAiProvider.stop).toHaveBeenCalledTimes(1);
    expect(anthropicProvider.start).toHaveBeenCalledTimes(1);
    expect(anthropicProvider.generateTurn).toHaveBeenCalledTimes(1);
    expect(runtimeProvider.name).toBe("anthropic");
    expect(reply).toEqual({ type: "assistant", content: "hi from anthropic" });
  });
});
