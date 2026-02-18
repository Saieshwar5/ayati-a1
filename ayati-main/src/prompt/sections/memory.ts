import { joinPromptBlocks } from "./shared.js";

export function renderMemorySection(summary: string): string {
  const cleanSummary = summary.trim();
  if (cleanSummary.length === 0) return "";
  return joinPromptBlocks(["# Memory", "## Previous Session Summary", cleanSummary]);
}
