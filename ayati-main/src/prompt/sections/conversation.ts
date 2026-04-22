import { formatConversationTurnSpeaker } from "../../memory/conversation-turn-format.js";
import type { ConversationTurn } from "../../memory/types.js";
import { joinPromptBlocks } from "./shared.js";

export function renderConversationLines(turns: ConversationTurn[]): string[] {
  return turns.map((turn) => {
    const ts = turn.timestamp.trim().length > 0 ? turn.timestamp : "unknown-time";
    const pathValue = typeof turn.sessionPath === "string" ? turn.sessionPath : "";
    const path = pathValue.trim().length > 0 ? pathValue : "unknown-path";
    const content = turn.content.trim();
    return `- [${ts}] [path=${path}] ${formatConversationTurnSpeaker(turn)}: ${content}`;
  });
}

export function renderConversationSection(turns: ConversationTurn[]): string {
  if (turns.length === 0) return "";

  return joinPromptBlocks(["# Previous Conversation", renderConversationLines(turns).join("\n")]);
}
