import type { LlmMessage } from "../core/contracts/llm-protocol.js";
import type { ConversationTurn } from "../memory/types.js";
import type { UserProfileContext } from "./types.js";

const MAX_TURNS = 30;

const SYSTEM_MESSAGE = `You are a context-extraction assistant. Your ONLY job is to analyze a conversation and extract factual information about the user.

Return a single JSON object with this exact structure:
{
  "user_profile_patch": { ... },
  "confidence": "none" | "low" | "medium" | "high",
  "reasoning": "brief explanation"
}

## user_profile_patch fields (all optional, omit if not found):
- name (string): user's real name
- nickname (string): preferred nickname
- occupation (string): job title or role
- location (string): city, country, etc.
- languages (string[]): programming or spoken languages
- interests (string[]): hobbies, topics of interest
- facts (string[]): notable personal facts
- people (string[]): names of people the user mentions (family, colleagues)
- projects (string[]): project names the user is working on
- communication.formality (string): "formal" | "casual" | "balanced"
- communication.verbosity (string): "brief" | "balanced" | "detailed"
- communication.humor_receptiveness (string): "low" | "medium" | "high"
- communication.emoji_usage (string): "none" | "rare" | "moderate" | "frequent"
- emotional_patterns.mood_baseline (string): general mood observed
- emotional_patterns.stress_triggers (string[]): topics that cause stress
- emotional_patterns.joy_triggers (string[]): topics that bring joy
- active_hours (string): when the user is typically active

## STRICT RULES:
1. Only extract what was EXPLICITLY stated or clearly demonstrated in the conversation.
2. For arrays: return ONLY new items to add — not duplicates of what already exists in the current profile.
3. Return confidence: "none" if there is nothing meaningful to extract.
4. Return ONLY the JSON object. No markdown fences, no explanation outside the JSON.`;

function formatTurns(turns: ConversationTurn[]): string {
  return turns
    .map((t) => `[${t.role}]: ${t.content}`)
    .join("\n\n");
}

export function buildExtractionMessages(
  turns: ConversationTurn[],
  currentProfile: UserProfileContext,
): LlmMessage[] {
  const recentTurns = turns.slice(-MAX_TURNS);

  const userContent = [
    "## Current User Profile",
    "```json",
    JSON.stringify(currentProfile, null, 2),
    "```",
    "",
    "## Conversation",
    formatTurns(recentTurns),
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_MESSAGE },
    { role: "user", content: userContent },
  ];
}
