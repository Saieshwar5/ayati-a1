import type { SoulContext, UserProfileContext } from "../context/types.js";
import type { ConversationTurn, ConversationWindowConfig } from "../memory/types.js";
import type { SkillPromptBlock } from "../skills/types.js";

export type PromptLayerId = "base" | "soul" | "user_profile" | "conversation" | "skills";

export interface PromptBuildInput {
  basePrompt: string;
  soul: SoulContext;
  userProfile: UserProfileContext;
  conversationTurns?: ConversationTurn[];
  skillBlocks?: SkillPromptBlock[];
  conversationWindow?: Partial<ConversationWindowConfig>;
}

export interface PromptSectionMetadata {
  id: PromptLayerId;
  bytes: number;
  included: boolean;
  reason?: string;
}

export interface PromptBuildOutput {
  systemPrompt: string;
  sections: PromptSectionMetadata[];
}
