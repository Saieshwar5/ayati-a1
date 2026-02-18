import {
  type PromptBuildInput,
  type PromptBuildOutput,
  type PromptLayerId,
  type PromptSectionMetadata,
} from "./types.js";
import { renderBasePromptSection } from "./sections/base.js";
import { renderConversationSection } from "./sections/conversation.js";
import { renderMemorySection } from "./sections/memory.js";
import { renderSkillsSection } from "./sections/skills.js";
import { renderSoulSection } from "./sections/soul.js";
import { renderUserProfileSection } from "./sections/user-profile.js";

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

function renderToolDirectorySection(toolDirectory: string | undefined, includeToolDirectory: boolean): string {
  if (!includeToolDirectory) return "";
  if (!toolDirectory || toolDirectory.trim().length === 0) return "";
  return `# Available Tools\n\n${toolDirectory}`;
}

export function buildSystemPrompt(input: PromptBuildInput): PromptBuildOutput {
  const base = renderBasePromptSection(input.basePrompt);
  const soul = renderSoulSection(input.soul);
  const profile = renderUserProfileSection(input.userProfile);
  const conversation = renderConversationSection(input.conversationTurns ?? []);
  const memory = renderMemorySection(input.previousSessionSummary ?? "");
  const skills = renderSkillsSection(input.skillBlocks ?? []);
  const tools = renderToolDirectorySection(input.toolDirectory, input.includeToolDirectory === true);

  const sections = [
    makeSection("base", base, "Base prompt is empty"),
    makeSection("soul", soul, "Soul context is empty"),
    makeSection("user_profile", profile, "User profile is empty"),
    makeSection("conversation", conversation, "No previous conversation available"),
    makeSection("memory", memory, "No previous session summary available"),
    makeSection("skills", skills, "No skills selected or available"),
    makeSection("tools", tools, "No tool directory available"),
  ];

  const systemPrompt = [base, soul, profile, conversation, memory, skills, tools]
    .filter((block) => block.trim().length > 0)
    .join("\n\n")
    .trim();

  return {
    systemPrompt,
    sections,
  };
}
