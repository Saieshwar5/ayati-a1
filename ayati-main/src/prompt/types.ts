import type { SoulContext } from "../context/types.js";
import type {
  ConversationTurn,
  PromptRunLedger,
  PromptTaskSummary,
  SessionStatus,
  SystemActivityItem,
} from "../memory/types.js";
import type { SkillPromptBlock } from "../skills/types.js";

export type PromptLayerId =
  | "base"
  | "soul"
  | "runtime_context"
  | "personal_memory"
  | "conversation"
  | "memory"
  | "current_session"
  | "recent_runs"
  | "recent_tasks"
  | "system_activity"
  | "skills"
  | "tools"
  | "session_status";

export interface PromptRuntimeContext {
  nowUtc: string;
  timezone: string;
  localDate: string;
  localTime: string;
  weekday: string;
}

export interface PromptBuildInput {
  basePrompt: string;
  soul: SoulContext;
  runtimeContext?: PromptRuntimeContext | null;
  personalMemorySnapshot?: string;
  conversationTurns?: ConversationTurn[];
  previousSessionSummary?: string;
  activeSessionPath?: string;
  recentRunLedgers?: PromptRunLedger[];
  recentTaskSummaries?: PromptTaskSummary[];
  recentSystemActivity?: SystemActivityItem[];
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
