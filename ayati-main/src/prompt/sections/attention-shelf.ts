import type { FocusShelfItem } from "../../memory/types.js";
import { joinPromptBlocks } from "./shared.js";

const MAX_SUMMARY_CHARS = 180;
const MAX_HINTS = 8;
const MAX_ARTIFACTS = 5;

export function renderAttentionShelfSection(items: FocusShelfItem[]): string {
  if (items.length === 0) {
    return "";
  }

  const lines = items.map((item, index) => {
    const parts = [
      `${index + 1}. ${item.focusId} [${item.type}, ${item.status}, touched ${item.lastTouchedLabel}]`,
      `Summary: ${truncateInline(item.summary, MAX_SUMMARY_CHARS)}`,
    ];
    if (item.hints.length > 0) {
      parts.push(`Hints: ${item.hints.slice(0, MAX_HINTS).join(", ")}`);
    }
    if (item.topArtifacts.length > 0) {
      parts.push(`Top artifacts: ${item.topArtifacts.slice(0, MAX_ARTIFACTS).join(", ")}`);
    }
    if (item.nextStep?.trim()) {
      parts.push(`Next step: ${truncateInline(item.nextStep, MAX_SUMMARY_CHARS)}`);
    }
    return parts.join("\n");
  });

  return joinPromptBlocks([
    "# Attention Shelf",
    "These are compact summaries of recent or high-lifespan focus items. Use them only when relevant to the current user message; they are not full history.",
    lines.join("\n\n"),
  ]);
}

function truncateInline(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

