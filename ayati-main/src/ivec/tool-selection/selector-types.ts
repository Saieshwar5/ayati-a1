import type { LlmToolSchema } from "../../core/contracts/llm-protocol.js";
import type { ToolSelectionHints } from "../../skills/types.js";

export interface SelectableTool {
  schema: LlmToolSchema;
  hints?: ToolSelectionHints;
}

export interface RankedTool {
  tool: SelectableTool;
  score: number;
  reasons: string[];
}

export interface ToolSelectionInput {
  query: string;
  tools: SelectableTool[];
  topK: number;
  alwaysInclude?: string[];
}

export interface ToolSelectionResult {
  selected: SelectableTool[];
  ranked: RankedTool[];
}
