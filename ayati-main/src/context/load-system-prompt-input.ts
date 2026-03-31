import type { PromptBuildInput } from "../prompt/types.js";
import type { PromptMemoryContext, SessionStatus } from "../memory/types.js";
import type { StaticContext } from "./static-context-cache.js";

export function assemblePromptInput(
  staticContext: StaticContext,
  memoryContext: PromptMemoryContext,
  sessionStatus?: SessionStatus | null,
): PromptBuildInput {
  return {
    basePrompt: staticContext.basePrompt,
    soul: staticContext.soul,
    userProfile: staticContext.userProfile,
    conversationTurns: memoryContext.conversationTurns,
    openFeedbacks: memoryContext.openFeedbacks,
    previousSessionSummary: memoryContext.previousSessionSummary,
    activeSessionPath: memoryContext.activeSessionPath,
    recentRunLedgers: memoryContext.recentRunLedgers,
    recentSystemActivity: memoryContext.recentSystemActivity,
    skillBlocks: staticContext.skillBlocks,
    toolDirectory: staticContext.toolDirectory,
    sessionStatus,
  };
}
