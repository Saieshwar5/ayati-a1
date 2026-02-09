import { buildSystemPrompt } from "../prompt/builder.js";
import { loadSystemPromptInput } from "./load-system-prompt-input.js";

/**
 * Backward-compatible wrapper. Prefer using loadSystemPromptInput + buildSystemPrompt directly.
 */
export async function loadContext(): Promise<string> {
  const input = await loadSystemPromptInput();
  return buildSystemPrompt(input).systemPrompt;
}
