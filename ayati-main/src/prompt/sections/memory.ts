import type { ToolMemoryEvent } from "../../memory/types.js";
import { joinPromptBlocks } from "./shared.js";

function renderToolEvent(event: ToolMemoryEvent): string {
  const status = event.status === "success" ? "ok" : "failed";
  const details = [
    `args=${event.argsPreview}`,
    event.outputPreview.trim().length > 0 ? `output=${event.outputPreview}` : "",
    event.errorMessage ? `error=${event.errorMessage}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("; ");

  return `- [${event.timestamp}] ${event.toolName} (${status}) ${details}`.trim();
}

export function renderMemorySection(summary: string, toolEvents: ToolMemoryEvent[]): string {
  const cleanSummary = summary.trim();
  const eventLines = toolEvents.map(renderToolEvent);

  if (cleanSummary.length === 0 && eventLines.length === 0) {
    return "";
  }

  const blocks = ["# Memory"];

  if (cleanSummary.length > 0) {
    blocks.push("## Previous Session Summary");
    blocks.push(cleanSummary);
  }

  if (eventLines.length > 0) {
    blocks.push("## Relevant Tool History");
    blocks.push(eventLines.join("\n"));
  }

  return joinPromptBlocks(blocks);
}
