import type { PromptTaskSummary } from "../../memory/types.js";
import { joinPromptBlocks } from "./shared.js";

const MAX_INLINE_CHARS = 140;

export function renderRecentTasksSection(tasks: PromptTaskSummary[]): string {
  if (tasks.length === 0) return "";

  const lines = tasks.map((task, index) => {
    const parts = [
      `- ${index + 1}. [${task.timestamp}]`,
      task.objective ? `objective=${truncateInline(task.objective)}` : "objective=(unspecified)",
      `task_status=${task.taskStatus}`,
      `run_status=${task.runStatus}`,
      `runPath=${task.runPath}`,
    ];

    if (task.progressSummary?.trim()) {
      parts.push(`progress=${truncateInline(task.progressSummary)}`);
    }
    if (task.openWork.length > 0) {
      parts.push(`open_work=${truncateInline(task.openWork.join("; "))}`);
    }
    if (task.blockers.length > 0) {
      parts.push(`blockers=${truncateInline(task.blockers.join("; "))}`);
    }
    if (task.summary.trim().length > 0) {
      parts.push(`summary=${truncateInline(task.summary)}`);
    }

    return parts.join(" ");
  });

  return joinPromptBlocks([
    "# Recent Tasks",
    "Ordered newest to oldest. These are task runs that passed understand and entered execution.",
    lines.join("\n"),
  ]);
}

function truncateInline(value: string, maxLen = MAX_INLINE_CHARS): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}
