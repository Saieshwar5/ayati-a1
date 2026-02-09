import { buildSystemPrompt } from "../prompt/builder.js";
import { loadStaticContext } from "./static-context-cache.js";
import { assemblePromptInput } from "./load-system-prompt-input.js";

/**
 * Backward-compatible wrapper. Prefer using assemblePromptInput + buildSystemPrompt directly.
 */
export async function loadContext(): Promise<string> {
  const staticCtx = await loadStaticContext();
  const input = assemblePromptInput(staticCtx, {
    conversationTurns: [],
    previousSessionSummary: "",
    toolEvents: [],
  });
  return buildSystemPrompt(input).systemPrompt;
}
