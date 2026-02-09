export interface SkillPromptBlock {
  id: string;
  content: string;
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
  getEnabledSkills(skillIds: string[]): Promise<SkillDefinition[]>;
  getEnabledSkillBlocks(skillIds: string[]): Promise<SkillPromptBlock[]>;
  getEnabledTools(skillIds: string[]): Promise<ToolDefinition[]>;
}
