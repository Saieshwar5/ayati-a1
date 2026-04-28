import type { SoulContext, ControllerPrompts } from "./types.js";
import type { SkillPromptBlock, ToolDefinition } from "../skills/types.js";
import { loadBasePrompt } from "./loaders/base-prompt-loader.js";
import { loadControllerPrompts } from "./loaders/controller-prompts-loader.js";
import { loadSoulContext } from "./loaders/soul-loader.js";
import type { SkillsProvider } from "../skills/types.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { buildToolDirectory } from "../ivec/tool-directory.js";

export interface StaticContext {
  basePrompt: string;
  soul: SoulContext;
  controllerPrompts: ControllerPrompts;
  skillBlocks: SkillPromptBlock[];
  toolDirectory: string;
}

export interface LoadStaticContextOptions {
  skillsProvider?: SkillsProvider;
  toolDefinitions?: ToolDefinition[];
}

export async function loadStaticContext(options?: LoadStaticContextOptions): Promise<StaticContext> {
  const skillsProvider = options?.skillsProvider ?? builtInSkillsProvider;

  const [basePrompt, soul, controllerPrompts, skillBlocks] = await Promise.all([
    loadBasePrompt(),
    loadSoulContext(),
    loadControllerPrompts(),
    skillsProvider.getAllSkillBlocks(),
  ]);

  const toolDirectory = buildToolDirectory(options?.toolDefinitions ?? []);

  return { basePrompt, soul, controllerPrompts, skillBlocks, toolDirectory };
}
