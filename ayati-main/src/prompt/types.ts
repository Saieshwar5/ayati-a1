import type { SoulContext, UserProfileContext } from "../context/types.js";
import type {
  ContextRecallStatus,
  ConversationTurn,
  RecalledContextEvidence,
  ToolMemoryEvent,
} from "../memory/types.js";
import type { SkillPromptBlock } from "../skills/types.js";

export type PromptLayerId =
  | "base"
  | "soul"
  | "user_profile"
  | "conversation"
  | "memory"
  | "skills";

export interface PromptBuildInput {
  basePrompt: string;
  soul: SoulContext;
  userProfile: UserProfileContext;
  conversationTurns?: ConversationTurn[];
  previousSessionSummary?: string;
  toolEvents?: ToolMemoryEvent[];
  recalledEvidence?: RecalledContextEvidence[];
  contextRecallStatus?: ContextRecallStatus;
  skillBlocks?: SkillPromptBlock[];
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
