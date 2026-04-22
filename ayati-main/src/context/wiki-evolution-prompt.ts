import type { LlmMessage } from "../core/contracts/llm-protocol.js";
import { formatConversationTurnInline } from "../memory/conversation-turn-format.js";
import type { ConversationTurn } from "../memory/types.js";
import type { UserWikiDocument, UserWikiSchema } from "./wiki-types.js";
import { renderUserWiki, renderUserWikiSchema } from "./wiki-format.js";

const MAX_TURNS = 30;

const SYSTEM_MESSAGE = `You are a wiki-extraction assistant. Your ONLY job is to update a durable personal wiki for the user.

Return a single JSON object with this exact structure:
{
  "section_updates": [
    {
      "section": "Section Name",
      "source": "explicit" | "inferred",
      "set_fields": { "Field": "Value" },
      "add_items": ["Item"]
    }
  ],
  "confidence": "none" | "low" | "medium" | "high",
  "reasoning": "brief explanation"
}

Rules:
- Use ONLY sections defined in the provided wiki schema.
- For key_value sections, use set_fields only.
- For bullet_list sections, use add_items only.
- Return ONLY new durable information that is not already in the current wiki.
- Save durable user knowledge, not temporary chatter.
- Never store secrets, passwords, OTPs, tokens, or other credentials.
- Prefer explicit user statements. Use inferred only for strong durable preferences.
- If nothing meaningful should be saved, return confidence "none" with an empty section_updates array.
- Return ONLY the JSON object. No markdown fences.`;

function formatTurns(turns: ConversationTurn[]): string {
  return turns.map((turn) => formatConversationTurnInline(turn)).join("\n\n");
}

export function buildWikiExtractionMessages(
  turns: ConversationTurn[],
  wiki: UserWikiDocument,
  schema: UserWikiSchema,
  handoffSummary?: string | null,
): LlmMessage[] {
  const recentTurns = turns.slice(-MAX_TURNS);
  const userContent = [
    "## Wiki Schema",
    "```text",
    renderUserWikiSchema(schema).trim(),
    "```",
    "",
    "## Current Wiki",
    "```text",
    renderUserWiki(wiki, schema).trim(),
    "```",
    handoffSummary?.trim() ? `\n## Session Handoff Summary\n${handoffSummary.trim()}` : "",
    "",
    "## Conversation",
    formatTurns(recentTurns),
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_MESSAGE },
    { role: "user", content: userContent },
  ];
}
