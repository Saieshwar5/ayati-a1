import type { SkillPromptBlock } from "../../skills/types.js";
import { joinPromptBlocks } from "./shared.js";

export function renderSkillsSection(skills: SkillPromptBlock[]): string {
  if (skills.length === 0) return "";

  const lines = skills
    .filter((skill) => skill.id.trim().length > 0 && skill.content.trim().length > 0)
    .map((skill) => `## Skill: ${skill.id}\n\n${skill.content.trim()}`);

  if (lines.length === 0) return "";

  return joinPromptBlocks(["# Skills", ...lines]);
}
