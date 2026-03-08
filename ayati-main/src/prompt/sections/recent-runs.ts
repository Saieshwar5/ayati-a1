import type { PromptRunLedger } from "../../memory/types.js";
import { joinPromptBlocks } from "./shared.js";

const MAX_SUMMARY_CHARS = 160;

export function renderRecentRunsSection(runs: PromptRunLedger[]): string {
  if (runs.length === 0) return "";

  const lines = runs.map((run, index) => {
    const status = run.status ? ` status=${run.status}` : "";
    const summaryText = run.summary?.trim().length
      ? ` summary=${truncateInline(run.summary, MAX_SUMMARY_CHARS)}`
      : "";

    return `- ${index + 1}. [${run.timestamp}] runId=${run.runId} state=${run.state}${status} runPath=${run.runPath}${summaryText}`;
  });

  return joinPromptBlocks([
    "# Recent Runs",
    "Ordered newest to oldest.",
    lines.join("\n"),
  ]);
}

function truncateInline(value: string, maxLen: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}
