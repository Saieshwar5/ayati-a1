export function normalize(items: string[]): string[] {
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

export function renderSection(title: string, items: string[]): string {
  if (items.length === 0) return "";
  const list = items.map((item) => `- ${item}`).join("\n");
  return `## ${title}\n\n${list}`;
}

export function joinPromptBlocks(blocks: string[]): string {
  return blocks.filter((b) => b.trim().length > 0).join("\n\n").trim();
}
