import type {
  RankedTool,
  SelectableTool,
  ToolSelectionInput,
  ToolSelectionResult,
} from "./selector-types.js";
import { scoreTool } from "./selector-scoring.js";

function stableSortRanked(ranked: RankedTool[]): RankedTool[] {
  return ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.tool.schema.name.localeCompare(b.tool.schema.name);
  });
}

function dedupeByName(tools: SelectableTool[]): SelectableTool[] {
  const byName = new Map<string, SelectableTool>();
  for (const tool of tools) {
    if (!byName.has(tool.schema.name)) {
      byName.set(tool.schema.name, tool);
    }
  }
  return [...byName.values()];
}

export function selectTools(input: ToolSelectionInput): ToolSelectionResult {
  const sourceTools = dedupeByName(input.tools);
  if (sourceTools.length === 0) return { selected: [], ranked: [] };

  const ranked = stableSortRanked(
    sourceTools.map((tool) => {
      const { score, reasons } = scoreTool(tool, input.query);
      return { tool, score, reasons };
    }),
  );

  const topK = Math.max(1, input.topK);
  const selected = ranked.slice(0, topK).map((r) => r.tool);
  const selectedByName = new Map(selected.map((tool) => [tool.schema.name, tool]));

  for (const requiredName of input.alwaysInclude ?? []) {
    const tool = sourceTools.find((t) => t.schema.name === requiredName);
    if (!tool) continue;
    selectedByName.set(tool.schema.name, tool);
  }

  return {
    selected: [...selectedByName.values()],
    ranked,
  };
}
