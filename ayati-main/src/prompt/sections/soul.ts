import type { SoulContext } from "../../context/types.js";
import { joinPromptBlocks, normalize, renderSection } from "./shared.js";

export function renderSoulSection(soul: SoulContext): string {
  const blocks: string[] = ["# Soul"];

  const name = soul.identity.name?.trim();
  if (name && name.length > 0) {
    blocks.push(`Name: ${name}`);
  }

  const role = soul.identity.role?.trim();
  if (role && role.length > 0) {
    blocks.push(`Role: ${role}`);
  }

  const responsibility = soul.identity.responsibility?.trim();
  if (responsibility && responsibility.length > 0) {
    blocks.push(`Responsibility: ${responsibility}`);
  }

  blocks.push(renderSection("Traits", normalize(soul.behavior.traits ?? [])));
  blocks.push(renderSection("Working Style", normalize(soul.behavior.working_style ?? [])));
  blocks.push(renderSection("Communication", normalize(soul.behavior.communication ?? [])));
  blocks.push(renderSection("Boundaries", normalize(soul.boundaries ?? [])));

  return joinPromptBlocks(blocks);
}
