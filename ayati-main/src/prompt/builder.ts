import type { ConversationTurn, ConversationWindowConfig } from "../memory/types.js";
import {
  type PromptBuildInput,
  type PromptBuildOutput,
  type PromptLayerId,
  type PromptSectionMetadata,
} from "./types.js";
import { renderBasePromptSection } from "./sections/base.js";
import { renderConversationSection } from "./sections/conversation.js";
import { renderSkillsSection } from "./sections/skills.js";
import { renderSoulSection } from "./sections/soul.js";
import { renderUserProfileSection } from "./sections/user-profile.js";

const DEFAULT_WINDOW: ConversationWindowConfig = {
  maxTurns: 12,
  maxChars: 4000,
};

function clipConversationTurns(
  turns: ConversationTurn[],
  config?: Partial<ConversationWindowConfig>,
): ConversationTurn[] {
  const maxTurns = config?.maxTurns ?? DEFAULT_WINDOW.maxTurns;
  const maxChars = config?.maxChars ?? DEFAULT_WINDOW.maxChars;

  const recent = turns.slice(-Math.max(0, maxTurns));
  const kept: ConversationTurn[] = [];
  let totalChars = 0;

  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i];
    if (!turn) continue;
    const cost = turn.content.length;
    if (totalChars + cost > maxChars) {
      break;
    }
    kept.push(turn);
    totalChars += cost;
  }

  return kept.reverse();
}

function makeSection(id: PromptLayerId, content: string, missingReason: string): PromptSectionMetadata {
  if (content.trim().length === 0) {
    return {
      id,
      bytes: 0,
      included: false,
      reason: missingReason,
    };
  }

  return {
    id,
    bytes: Buffer.byteLength(content, "utf-8"),
    included: true,
  };
}

export function buildSystemPrompt(input: PromptBuildInput): PromptBuildOutput {
  const base = renderBasePromptSection(input.basePrompt);
  const soul = renderSoulSection(input.soul);
  const profile = renderUserProfileSection(input.userProfile);
  const conversation = renderConversationSection(
    clipConversationTurns(input.conversationTurns ?? [], input.conversationWindow),
  );
  const skills = renderSkillsSection(input.skillBlocks ?? []);

  const sections = [
    makeSection("base", base, "Base prompt is empty"),
    makeSection("soul", soul, "Soul context is empty"),
    makeSection("user_profile", profile, "User profile is empty"),
    makeSection("conversation", conversation, "No previous conversation available"),
    makeSection("skills", skills, "No skills selected or available"),
  ];

  const systemPrompt = [base, soul, profile, conversation, skills]
    .filter((block) => block.trim().length > 0)
    .join("\n\n")
    .trim();

  return {
    systemPrompt,
    sections,
  };
}
