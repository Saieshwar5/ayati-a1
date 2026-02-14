import type {
  ContextRecallStatus,
  RecalledContextEvidence,
  ToolMemoryEvent,
} from "../../memory/types.js";
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

export function renderMemorySection(
  summary: string,
  toolEvents: ToolMemoryEvent[],
  recalledEvidence: RecalledContextEvidence[] = [],
  contextRecallStatus?: ContextRecallStatus,
): string {
  const cleanSummary = summary.trim();
  const eventLines = toolEvents.map(renderToolEvent);
  const evidenceLines = recalledEvidence.map((evidence) => {
    const confidence = Number.isFinite(evidence.confidence)
      ? evidence.confidence.toFixed(2)
      : "0.00";
    return `- [session=${evidence.sessionId} ${evidence.turnRef} ${evidence.timestamp} conf=${confidence}] ${evidence.snippet} (why: ${evidence.whyRelevant})`;
  });
  const statusLines = contextRecallStatus
    ? [
        `- mode=auto`,
        `- status=${contextRecallStatus.status}`,
        `- reason=${contextRecallStatus.reason}`,
        `- searched_sessions=${contextRecallStatus.searchedSessions}`,
        `- model_calls=${contextRecallStatus.modelCalls}`,
        contextRecallStatus.triggerReason
          ? `- trigger_reason=${contextRecallStatus.triggerReason}`
          : "",
      ].filter((line) => line.length > 0)
    : [];

  if (
    cleanSummary.length === 0 &&
    eventLines.length === 0 &&
    evidenceLines.length === 0 &&
    statusLines.length === 0
  ) {
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

  if (evidenceLines.length > 0) {
    blocks.push("## Recalled Context Evidence");
    blocks.push(evidenceLines.join("\n"));
  }

  if (statusLines.length > 0) {
    blocks.push("## Context Recall Agent");
    blocks.push(statusLines.join("\n"));
    if (contextRecallStatus?.status === "not_found") {
      blocks.push(
        "Instruction: No reliable historical evidence was found. Do not invent past-context facts.",
      );
    }
  }

  return joinPromptBlocks(blocks);
}
