import { joinPromptBlocks } from "./shared.js";

const CONTINUITY_INSTRUCTION =
  "You are continuing from a previous session. " +
  "Do not re-ask the user for information already covered in the handoff summary above. " +
  "Pick up where the previous session left off.";

export function renderMemorySection(summary: string): string {
  const cleanSummary = summary.trim();
  if (cleanSummary.length === 0) return "";

  const blocks = ["# Memory", "## Previous Session Summary", cleanSummary];
  blocks.push("## Continuing from Previous Session", CONTINUITY_INSTRUCTION);

  return joinPromptBlocks(blocks);
}
