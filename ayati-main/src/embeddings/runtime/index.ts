import {
  getActiveEmbeddingProvider,
  type SupportedEmbeddingProvider,
} from "../../config/llm-runtime-config.js";
import type { EmbeddingProvider } from "../contracts.js";
import { getActiveEvaluationRecorder } from "../../evaluation/capture-runtime.js";

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
    const operationStarted = process.hrtime.bigint();
    try {
      const result = await provider.embed(text);
      getActiveEvaluationRecorder()?.record({
        stage: "embedding",
        event: "completed",
        data: { provider: provider.name, model: provider.modelName, text, dimensions: result.length, durationMs: elapsedMs(operationStarted) },
      });
      return result;
    } catch (error) {
      getActiveEvaluationRecorder()?.record({
        stage: "embedding",
        event: "failed",
        data: { provider: provider.name, model: provider.modelName, text, error, durationMs: elapsedMs(operationStarted) },
      });
      throw error;
    }
  },

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!started) {
      throw new Error("Embedding runtime provider not started.");
    }

    const provider = await ensureActiveProvider();
    const operationStarted = process.hrtime.bigint();
    try {
      const result = await provider.embedBatch(texts);
      getActiveEvaluationRecorder()?.record({
        stage: "embedding",
        event: "completed",
        data: {
          provider: provider.name,
          model: provider.modelName,
          texts,
          count: result.length,
          dimensions: result.map((value) => value.length),
          durationMs: elapsedMs(operationStarted),
        },
      });
      return result;
    } catch (error) {
      getActiveEvaluationRecorder()?.record({
        stage: "embedding",
        event: "failed",
        data: { provider: provider.name, model: provider.modelName, texts, error, durationMs: elapsedMs(operationStarted) },
      });
      throw error;
    }
  },
};

function elapsedMs(startedNs: bigint): number {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
}

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
