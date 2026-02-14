export interface SkillPromptBlock {
  id: string;
  content: string;
}

export interface ToolSelectionHints {
  tags?: string[];
  aliases?: string[];
  examples?: string[];
  domain?: string;
  priority?: number;
}

export interface ToolExecutionContext {
  clientId?: string;
}

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  selectionHints?: ToolSelectionHints;
  execute(input: unknown, context?: ToolExecutionContext): Promise<ToolResult>;
}

export interface SkillDefinition {
  id: string;
  version: string;
  description: string;
  promptBlock: string;
  tools: ToolDefinition[];
}

export interface SkillsProvider {
  getAllSkills(): Promise<SkillDefinition[]>;
  getAllSkillBlocks(): Promise<SkillPromptBlock[]>;
  getAllTools(): Promise<ToolDefinition[]>;
}
