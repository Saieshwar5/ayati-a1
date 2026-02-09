import type { SoulContext } from "../../context/types.js";
import { joinPromptBlocks, normalize, renderSection } from "./shared.js";

export function renderSoulSection(soul: SoulContext): string {
  const blocks: string[] = ["# Soul"];

  const name = soul.soul.name?.trim();
  if (name && name.length > 0) {
    blocks.push(`Name: ${name}`);
  }

  const identity = soul.soul.identity?.trim();
  if (identity && identity.length > 0) {
    blocks.push(identity);
  }
  blocks.push(renderSection("Personality", normalize(soul.soul.personality ?? [])));
  blocks.push(renderSection("Values", normalize(soul.soul.values ?? [])));

  blocks.push("# Voice");
  blocks.push(renderSection("Tone", normalize(soul.voice.tone ?? [])));
  blocks.push(renderSection("Style", normalize(soul.voice.style ?? [])));
  blocks.push(renderSection("Quirks", normalize(soul.voice.quirks ?? [])));
  blocks.push(renderSection("Never Do", normalize(soul.voice.never_do ?? [])));

  return joinPromptBlocks(blocks);
}
