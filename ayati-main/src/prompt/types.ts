import type { SoulContext, UserProfileContext } from "../context/types.js";
import type { ConversationTurn, PromptRunLedger, SessionStatus } from "../memory/types.js";
import type { SkillPromptBlock } from "../skills/types.js";

export type PromptLayerId =
  | "base"
  | "soul"
  | "user_profile"
  | "conversation"
  | "memory"
  | "current_session"
  | "recent_runs"
  | "skills"
  | "tools"
  | "session_status";

export interface PromptBuildInput {
  basePrompt: string;
  soul: SoulContext;
  userProfile: UserProfileContext;
  conversationTurns?: ConversationTurn[];
  previousSessionSummary?: string;
  activeSessionPath?: string;
  recentRunLedgers?: PromptRunLedger[];
  skillBlocks?: SkillPromptBlock[];
  toolDirectory?: string;
  includeToolDirectory?: boolean;
  sessionStatus?: SessionStatus | null;
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
