import type { SoulContext, UserProfileContext } from "./types.js";
import type { SkillPromptBlock, ToolDefinition } from "../skills/types.js";
import { loadBasePrompt } from "./loaders/base-prompt-loader.js";
import { loadSoulContext } from "./loaders/soul-loader.js";
import { loadUserProfileContext } from "./loaders/user-profile-loader.js";
import type { SkillsProvider } from "../skills/types.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { buildToolDirectory } from "../ivec/tool-directory.js";

export interface StaticContext {
  basePrompt: string;
  soul: SoulContext;
  userProfile: UserProfileContext;
  skillBlocks: SkillPromptBlock[];
  toolDirectory: string;
}

export interface LoadStaticContextOptions {
  skillsProvider?: SkillsProvider;
  toolDefinitions?: ToolDefinition[];
}

export async function loadStaticContext(options?: LoadStaticContextOptions): Promise<StaticContext> {
  const skillsProvider = options?.skillsProvider ?? builtInSkillsProvider;

  const [basePrompt, soul, userProfile, skillBlocks] = await Promise.all([
    loadBasePrompt(),
    loadSoulContext(),
    loadUserProfileContext(),
    skillsProvider.getAllSkillBlocks(),
  ]);

  const toolDirectory = buildToolDirectory(options?.toolDefinitions ?? []);

  return { basePrompt, soul, userProfile, skillBlocks, toolDirectory };
}
