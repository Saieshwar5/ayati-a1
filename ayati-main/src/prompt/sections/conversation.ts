import type { ConversationTurn } from "../../memory/types.js";
import { joinPromptBlocks } from "./shared.js";

export function renderConversationSection(turns: ConversationTurn[]): string {
  if (turns.length === 0) return "";

  const lines = turns.map((turn) => {
    const ts = turn.timestamp.trim().length > 0 ? turn.timestamp : "unknown-time";
    const pathValue = typeof turn.sessionPath === "string" ? turn.sessionPath : "";
    const path = pathValue.trim().length > 0 ? pathValue : "unknown-path";
    const content = turn.content.trim();
    return `- [${ts}] [path=${path}] ${turn.role}: ${content}`;
  });

  return joinPromptBlocks(["# Previous Conversation", lines.join("\n")]);
}
