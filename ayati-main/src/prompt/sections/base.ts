import { joinPromptBlocks } from "./shared.js";

export function renderBasePromptSection(basePrompt: string): string {
  const content = basePrompt.trim();
  if (content.length === 0) return "";
  return joinPromptBlocks(["# Base System Prompt", content]);
}
