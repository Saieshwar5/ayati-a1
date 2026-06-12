import type { SoulContext } from "./types.js";
import type { SkillPromptBlock, ToolDefinition } from "../skills/types.js";
import { loadBasePrompt } from "./loaders/base-prompt-loader.js";
import { loadSoulContext } from "./loaders/soul-loader.js";
import type { SkillsProvider } from "../skills/types.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { buildToolDirectory } from "../ivec/tool-directory.js";

export interface StaticContext {
  basePrompt: string;
  soul: SoulContext;
  skillBlocks: SkillPromptBlock[];
  toolDirectory: string;
}

export interface LoadStaticContextOptions {
  skillsProvider?: SkillsProvider;
  toolDefinitions?: ToolDefinition[];
}

export async function loadStaticContext(options?: LoadStaticContextOptions): Promise<StaticContext> {
  const skillsProvider = options?.skillsProvider ?? builtInSkillsProvider;

  const [basePrompt, soul, skillBlocks] = await Promise.all([
    loadBasePrompt(),
    loadSoulContext(),
    skillsProvider.getAllSkillBlocks(),
  ]);

  const toolDirectory = buildToolDirectory(options?.toolDefinitions ?? []);

  return { basePrompt, soul, skillBlocks, toolDirectory };
}
