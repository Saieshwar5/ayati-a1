import {
  getActiveImageGenerationProvider,
  type SupportedImageGenerationProvider,
} from "../../config/llm-runtime-config.js";
import type {
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageGenerationProvider,
} from "../contracts.js";
import { getActiveEvaluationRecorder } from "../../evaluation/capture-runtime.js";

let activeProviderName: SupportedImageGenerationProvider | null = null;
let activeProvider: ImageGenerationProvider | null = null;
let started = false;

const runtimeImageGenerationProvider: ImageGenerationProvider = {
  get name() {
    return activeProvider?.name ?? getActiveImageGenerationProvider();
  },

  get modelName() {
    return activeProvider?.modelName ?? "";
  },

  async start() {
    started = true;
    await ensureActiveProvider();
  },

  async stop() {
    started = false;
    await stopActiveProvider();
  },

  async generateImage(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    if (!started) {
      throw new Error("Image generation runtime provider not started.");
    }

    const provider = await ensureActiveProvider();
    const operationStarted = process.hrtime.bigint();
    try {
      const result = await provider.generateImage(input);
      getActiveEvaluationRecorder()?.record({
        stage: "image_generation",
        event: "completed",
        data: { provider: provider.name, model: provider.modelName, input, output: result, durationMs: elapsedMs(operationStarted) },
      });
      return result;
    } catch (error) {
      getActiveEvaluationRecorder()?.record({
        stage: "image_generation",
        event: "failed",
        data: { provider: provider.name, model: provider.modelName, input, error, durationMs: elapsedMs(operationStarted) },
      });
      throw error;
    }
  },
};

function elapsedMs(startedNs: bigint): number {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
}

export default runtimeImageGenerationProvider;

async function ensureActiveProvider(): Promise<ImageGenerationProvider> {
  const configuredProvider = getActiveImageGenerationProvider();

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

async function loadProviderModule(provider: SupportedImageGenerationProvider): Promise<ImageGenerationProvider> {
  switch (provider) {
    case "openai":
      return (await import("../openai/index.js")).default;
    default:
      throw new Error(`Unsupported configured image generation provider "${provider}".`);
  }
}
