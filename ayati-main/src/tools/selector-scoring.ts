import type { SelectableTool } from "./selector-types.js";

function tokenize(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  const matches = text.toLowerCase().match(/[a-z0-9_]+/g);
  return matches ?? [];
}

function toSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

function countOverlap(queryTokens: Set<string>, targetTokens: Set<string>): number {
  let count = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) count++;
  }
  return count;
}

function schemaPropertyTokens(tool: SelectableTool): string[] {
  const props = (tool.schema.inputSchema["properties"] ?? {}) as Record<string, unknown>;
  return Object.keys(props);
}

export function scoreTool(tool: SelectableTool, query: string): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const queryTokens = toSet(tokenize(query));
  if (queryTokens.size === 0) return { score: 0, reasons };

  const nameTokens = toSet(tokenize(tool.schema.name.replace(/_/g, " ")));
  const descriptionTokens = toSet(tokenize(tool.schema.description));
  const propertyTokens = toSet(tokenize(schemaPropertyTokens(tool).join(" ")));
  const hintTokens = toSet(tokenize(
    [
      ...(tool.hints?.tags ?? []),
      ...(tool.hints?.aliases ?? []),
      ...(tool.hints?.examples ?? []),
      tool.hints?.domain ?? "",
    ].join(" "),
  ));

  const nameHits = countOverlap(queryTokens, nameTokens);
  const descHits = countOverlap(queryTokens, descriptionTokens);
  const propHits = countOverlap(queryTokens, propertyTokens);
  const hintHits = countOverlap(queryTokens, hintTokens);

  let score = 0;

  if (nameHits > 0) {
    score += nameHits * 6;
    reasons.push(`name:${nameHits}`);
  }
  if (hintHits > 0) {
    score += hintHits * 4;
    reasons.push(`hints:${hintHits}`);
  }
  if (descHits > 0) {
    score += descHits * 2;
    reasons.push(`description:${descHits}`);
  }
  if (propHits > 0) {
    score += propHits * 3;
    reasons.push(`schema:${propHits}`);
  }

  const priority = tool.hints?.priority;
  if (typeof priority === "number" && Number.isFinite(priority)) {
    score += priority;
    reasons.push(`priority:${priority}`);
  }

  return { score, reasons };
}
