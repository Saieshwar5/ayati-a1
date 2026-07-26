import type { SoulContext } from "./types.js";
import { loadBasePrompt } from "./loaders/base-prompt-loader.js";
import { loadSoulContext } from "./loaders/soul-loader.js";

export interface StaticContext {
  basePrompt: string;
  soul: SoulContext;
}

export async function loadStaticContext(): Promise<StaticContext> {
  const [basePrompt, soul] = await Promise.all([
    loadBasePrompt(),
    loadSoulContext(),
  ]);
  return { basePrompt, soul };
}
