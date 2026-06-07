import {
  getActiveImageGenerationProvider,
  type SupportedImageGenerationProvider,
} from "../../config/llm-runtime-config.js";
import type {
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageGenerationProvider,
} from "../contracts.js";

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
    return provider.generateImage(input);
  },
};

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
