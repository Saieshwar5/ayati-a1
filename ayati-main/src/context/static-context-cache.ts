import type { SoulContext, UserProfileContext } from "./types.js";
import type { SkillPromptBlock } from "../skills/types.js";
import { loadBasePrompt } from "./loaders/base-prompt-loader.js";
import { loadSoulContext } from "./loaders/soul-loader.js";
import { loadUserProfileContext } from "./loaders/user-profile-loader.js";
import { loadSkillsWhitelist } from "./loaders/skills-whitelist-loader.js";
import type { SkillsProvider } from "../skills/types.js";
import { builtInSkillsProvider } from "../skills/provider.js";

export interface StaticContext {
  basePrompt: string;
  soul: SoulContext;
  userProfile: UserProfileContext;
  skillBlocks: SkillPromptBlock[];
}

export interface LoadStaticContextOptions {
  skillsProvider?: SkillsProvider;
}

export async function loadStaticContext(options?: LoadStaticContextOptions): Promise<StaticContext> {
  const skillsProvider = options?.skillsProvider ?? builtInSkillsProvider;

  const [basePrompt, soul, userProfile, whitelistedSkillIds] = await Promise.all([
    loadBasePrompt(),
    loadSoulContext(),
    loadUserProfileContext(),
    loadSkillsWhitelist(),
  ]);

  const skillBlocks = await skillsProvider.getEnabledSkillBlocks(whitelistedSkillIds);

  return { basePrompt, soul, userProfile, skillBlocks };
}
