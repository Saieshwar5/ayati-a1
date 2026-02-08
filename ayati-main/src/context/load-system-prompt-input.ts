import type { PromptBuildInput } from "../prompt/types.js";
import { noopConversationMemoryProvider } from "../memory/provider.js";
import type { ConversationMemoryProvider } from "../memory/types.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import type { SkillsProvider } from "../skills/types.js";
import { loadBasePrompt } from "./loaders/base-prompt-loader.js";
import { loadSkillsWhitelist } from "./loaders/skills-whitelist-loader.js";
import { loadSoulContext } from "./loaders/soul-loader.js";
import { loadUserProfileContext } from "./loaders/user-profile-loader.js";

export interface LoadSystemPromptInputOptions {
  clientId?: string;
  memoryProvider?: ConversationMemoryProvider;
  skillsProvider?: SkillsProvider;
}

export async function loadSystemPromptInput(
  options?: LoadSystemPromptInputOptions,
): Promise<PromptBuildInput> {
  const memoryProvider = options?.memoryProvider ?? noopConversationMemoryProvider;
  const skillsProvider = options?.skillsProvider ?? builtInSkillsProvider;

  const [
    basePrompt,
    soul,
    userProfile,
    conversationTurns,
    whitelistedSkillIds,
  ] = await Promise.all([
    loadBasePrompt(),
    loadSoulContext(),
    loadUserProfileContext(),
    memoryProvider.getRecentTurns(options?.clientId),
    loadSkillsWhitelist(),
  ]);

  const skillBlocks = await skillsProvider.getEnabledSkillBlocks(whitelistedSkillIds);

  return {
    basePrompt,
    soul,
    userProfile,
    conversationTurns,
    skillBlocks,
  };
}
