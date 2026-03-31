import type { OpenFeedbackItem } from "../../memory/types.js";
import { joinPromptBlocks } from "./shared.js";

export function renderOpenFeedbackSection(items: OpenFeedbackItem[]): string {
  if (items.length === 0) return "";

  const lines = items.map((item, index) => {
    const hints = item.entityHints.length > 0 ? ` hints=${item.entityHints.join(",")}` : "";
    const action = item.actionType ? ` action=${item.actionType}` : "";
    const payload = item.payloadSummary?.trim().length ? ` payload=${item.payloadSummary}` : "";
    return `- ${index + 1}. feedbackId=${item.feedbackId} kind=${item.kind}${action} label=${item.shortLabel}${hints}\n  asked_at=${item.createdAt}\n  message=${item.message}${payload}`;
  });

  return joinPromptBlocks([
    "# Open Feedback Requests",
    "These feedback requests are still unresolved. Only act on one when the current user message clearly refers to it.",
    lines.join("\n"),
  ]);
}
