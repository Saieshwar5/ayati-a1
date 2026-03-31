import type { SystemActivityItem } from "../../memory/types.js";
import { joinPromptBlocks } from "./shared.js";

export function renderSystemActivitySection(items: SystemActivityItem[]): string {
  if (items.length === 0) return "";

  const lines = items.map((item, index) => {
    const responseKind = item.responseKind ? ` response=${item.responseKind}` : "";
    const visibility = item.userVisible ? "user_visible" : "silent";
    const note = item.note?.trim().length ? ` note=${item.note}` : "";
    return `- ${index + 1}. [${item.timestamp}] ${item.source}/${item.event} eventId=${item.eventId} visibility=${visibility}${responseKind}\n  summary=${item.summary}${note}`;
  });

  return joinPromptBlocks([
    "# Recent System Activity",
    "Newest activity is last in the list. This includes system-event outcomes and user-visible notifications.",
    lines.join("\n"),
  ]);
}
