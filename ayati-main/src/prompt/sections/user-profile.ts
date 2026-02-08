import type { UserProfileContext } from "../../context/types.js";
import { joinPromptBlocks, normalize, renderSection } from "./shared.js";

function renderField(label: string, value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return `${label}: ${trimmed}`;
}

export function renderUserProfileSection(profile: UserProfileContext): string {
  const blocks: string[] = ["# User Profile"];

  blocks.push(
    renderSection(
      "Identity",
      [
        renderField("Name", profile.name),
        renderField("Nickname", profile.nickname),
        renderField("Occupation", profile.occupation),
        renderField("Location", profile.location),
        renderField("Active Hours", profile.active_hours),
        `Last Updated: ${profile.last_updated}`,
      ].filter((item): item is string => typeof item === "string"),
    ),
  );
  blocks.push(renderSection("Languages", normalize(profile.languages)));
  blocks.push(renderSection("Interests", normalize(profile.interests)));
  blocks.push(renderSection("Known Facts", normalize(profile.facts)));
  blocks.push(renderSection("People", normalize(profile.people)));
  blocks.push(renderSection("Projects", normalize(profile.projects)));
  blocks.push(
    renderSection("Communication", [
      `Formality: ${profile.communication.formality}`,
      `Verbosity: ${profile.communication.verbosity}`,
      `Humor Receptiveness: ${profile.communication.humor_receptiveness}`,
      `Emoji Usage: ${profile.communication.emoji_usage}`,
    ]),
  );
  blocks.push(
    renderSection("Emotional Patterns", [
      `Mood Baseline: ${profile.emotional_patterns.mood_baseline}`,
      ...normalize(profile.emotional_patterns.stress_triggers).map((v) => `Stress Trigger: ${v}`),
      ...normalize(profile.emotional_patterns.joy_triggers).map((v) => `Joy Trigger: ${v}`),
    ]),
  );

  return joinPromptBlocks(blocks);
}
