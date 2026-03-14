import {
  getActiveProvider,
  type SupportedLlmProvider,
} from "../../config/llm-runtime-config.js";
import type { LlmProvider } from "../../core/contracts/provider.js";
import type {
  LlmInputTokenCount,
  LlmProviderCapabilities,
  LlmTurnInput,
  LlmTurnOutput,
} from "../../core/contracts/llm-protocol.js";
import { getProviderCapabilities } from "../shared/provider-profiles.js";

let activeProviderName: SupportedLlmProvider | null = null;
let activeProvider: LlmProvider | null = null;
let started = false;

const runtimeProvider: LlmProvider = {
  get name() {
    return activeProvider?.name ?? getActiveProvider();
  },

  get version() {
    return activeProvider?.version ?? "1.0.0";
  },

  get capabilities() {
    return activeProvider?.capabilities ?? getProviderCapabilities(getActiveProvider());
  },

  async start() {
    started = true;
    await ensureActiveProvider();
  },

  async stop() {
    started = false;
    await stopActiveProvider();
  },

  async countInputTokens(input: LlmTurnInput): Promise<LlmInputTokenCount> {
    if (!started) {
      throw new Error("Runtime provider not started.");
    }

    const provider = await ensureActiveProvider();
    if (!provider.countInputTokens) {
      throw new Error(`Provider "${provider.name}" does not support input token counting.`);
    }

    return provider.countInputTokens(input);
  },

  async generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput> {
    if (!started) {
      throw new Error("Runtime provider not started.");
    }

    const provider = await ensureActiveProvider();
    return provider.generateTurn(input);
  },
};

export default runtimeProvider;

async function ensureActiveProvider(): Promise<LlmProvider> {
  const configuredProvider = getActiveProvider();

  if (activeProvider && activeProviderName === configuredProvider) {
    return activeProvider;
  }

  await stopActiveProvider();

  const nextProvider = await loadProviderModule(configuredProvider);

  if (started) {
    await nextProvider.start();
  }

  activeProviderName = configuredProvider;
  activeProvider = nextProvider;

  return nextProvider;
}

async function stopActiveProvider(): Promise<void> {
  if (activeProvider) {
    await activeProvider.stop();
  }

  activeProvider = null;
  activeProviderName = null;
}

async function loadProviderModule(provider: SupportedLlmProvider): Promise<LlmProvider> {
  switch (provider) {
    case "fireworks":
      return (await import("../fireworks/index.js")).default;
    case "openrouter":
      return (await import("../openrouter/index.js")).default;
    case "openai":
      return (await import("../openai/index.js")).default;
    case "anthropic":
      return (await import("../anthropic/index.js")).default;
    default:
      throw new Error(`Unsupported configured provider "${provider}".`);
  }
}
