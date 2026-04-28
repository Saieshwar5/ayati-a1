import { joinPromptBlocks } from "./shared.js";

export function renderPersonalMemorySection(snapshot: string): string {
  const clean = snapshot.trim();
  if (clean.length === 0) {
    return "";
  }

  return joinPromptBlocks([
    "# Personal Memory Snapshot",
    "Use these compact user-personalization memories as advisory context. Current user messages override them.",
    clean,
  ]);
}
