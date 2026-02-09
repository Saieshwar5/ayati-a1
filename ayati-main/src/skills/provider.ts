import calculatorSkill from "./builtins/calculator/index.js";
import shellSkill from "./builtins/shell/index.js";
import type {
  SkillDefinition,
  SkillPromptBlock,
  SkillsProvider,
  ToolDefinition,
} from "./types.js";

const BUILTIN_SKILLS: SkillDefinition[] = [shellSkill, calculatorSkill];

export const builtInSkillsProvider: SkillsProvider = {
  async getAllSkills(): Promise<SkillDefinition[]> {
    return BUILTIN_SKILLS;
  },

  async getAllSkillBlocks(): Promise<SkillPromptBlock[]> {
    return BUILTIN_SKILLS.map((skill) => ({ id: skill.id, content: skill.promptBlock }));
  },

  async getAllTools(): Promise<ToolDefinition[]> {
    return BUILTIN_SKILLS.flatMap((skill) => skill.tools);
  },
};

export const noopSkillsProvider: SkillsProvider = {
  async getAllSkills(): Promise<SkillDefinition[]> {
    return [];
  },

  async getAllSkillBlocks(): Promise<SkillPromptBlock[]> {
    return [];
  },

  async getAllTools(): Promise<ToolDefinition[]> {
    return [];
  },
};
