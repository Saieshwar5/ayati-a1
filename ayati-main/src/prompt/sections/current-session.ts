import { joinPromptBlocks } from "./shared.js";

export function renderCurrentSessionSection(activeSessionPath: string): string {
  const path = activeSessionPath.trim();
  if (path.length === 0) return "";

  return joinPromptBlocks([
    "# Current Session",
    `- session_path: ${path}`,
  ]);
}
