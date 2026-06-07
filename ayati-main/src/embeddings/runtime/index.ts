import {
  getActiveEmbeddingProvider,
  type SupportedEmbeddingProvider,
} from "../../config/llm-runtime-config.js";
import type { EmbeddingProvider } from "../contracts.js";

let activeProviderName: SupportedEmbeddingProvider | null = null;
let activeProvider: EmbeddingProvider | null = null;
let started = false;

const runtimeEmbeddingProvider: EmbeddingProvider = {
  get name() {
    return activeProvider?.name ?? getActiveEmbeddingProvider();
  },

  get modelName() {
    return activeProvider?.modelName ?? "";
  },

  get dimensions() {
    return activeProvider?.dimensions;
  },

  async start() {
    started = true;
    await ensureActiveProvider();
  },

  async stop() {
    started = false;
    await stopActiveProvider();
  },

  async embed(text: string): Promise<number[]> {
    if (!started) {
      throw new Error("Embedding runtime provider not started.");
    }

    const provider = await ensureActiveProvider();
    return provider.embed(text);
  },

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!started) {
      throw new Error("Embedding runtime provider not started.");
    }

    const provider = await ensureActiveProvider();
    return provider.embedBatch(texts);
  },
};

export default runtimeEmbeddingProvider;

async function ensureActiveProvider(): Promise<EmbeddingProvider> {
  const configuredProvider = getActiveEmbeddingProvider();

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

async function loadProviderModule(provider: SupportedEmbeddingProvider): Promise<EmbeddingProvider> {
  switch (provider) {
    case "openai":
      return (await import("../openai/index.js")).default;
    default:
      throw new Error(`Unsupported configured embedding provider "${provider}".`);
  }
}
