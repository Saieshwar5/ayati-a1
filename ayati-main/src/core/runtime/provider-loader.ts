import type { LlmProvider } from "../contracts/provider.js";

export type ProviderFactory = () => Promise<{ default: LlmProvider }>;

export async function loadProvider(factory: ProviderFactory): Promise<LlmProvider> {
  const loaded = await factory();
  if (!loaded?.default) {
    throw new Error("Invalid provider module: expected a default export.");
  }
  return loaded.default;
}
