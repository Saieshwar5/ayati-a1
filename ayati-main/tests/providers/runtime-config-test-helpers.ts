import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeLlmRuntimeConfig,
  resetLlmRuntimeConfigForTests,
  setActiveProvider,
  setModelForProvider,
  type SupportedLlmProvider,
} from "../../src/config/llm-runtime-config.js";

export interface ProviderRuntimeConfigHandle {
  cleanup(): Promise<void>;
}

export async function setupProviderRuntimeConfig(
  provider: SupportedLlmProvider,
  model?: string,
): Promise<ProviderRuntimeConfigHandle> {
  const tempDir = await mkdtemp(join(tmpdir(), "ayati-llm-config-"));
  const configPath = join(tempDir, "llm-config.json");

  await initializeLlmRuntimeConfig({ configPath });
  await setActiveProvider(provider);

  if (model) {
    await setModelForProvider(provider, model);
  }

  return {
    async cleanup() {
      resetLlmRuntimeConfigForTests();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
