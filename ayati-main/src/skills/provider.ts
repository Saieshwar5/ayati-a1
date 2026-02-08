import { devWarn } from "../shared/index.js";
import shellSkill from "./builtins/shell/index.js";
import type {
  SkillDefinition,
  SkillPromptBlock,
  SkillsProvider,
  ToolDefinition,
} from "./types.js";

const BUILTIN_SKILLS: SkillDefinition[] = [shellSkill];

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function buildIndex(skills: SkillDefinition[]): Map<string, SkillDefinition> {
  return new Map(skills.map((skill) => [skill.id, skill]));
}

export const builtInSkillsProvider: SkillsProvider = {
  async getEnabledSkills(skillIds: string[]): Promise<SkillDefinition[]> {
    const ids = dedupe(skillIds);
    const index = buildIndex(BUILTIN_SKILLS);
    const selected: SkillDefinition[] = [];

    for (const id of ids) {
      const skill = index.get(id);
      if (!skill) {
        devWarn(`Skill not found in built-in registry, skipping: ${id}`);
        continue;
      }
      selected.push(skill);
    }

    return selected;
  },

  async getEnabledSkillBlocks(skillIds: string[]): Promise<SkillPromptBlock[]> {
    const skills = await this.getEnabledSkills(skillIds);
    return skills.map((skill) => ({ id: skill.id, content: skill.promptBlock }));
  },

  async getEnabledTools(skillIds: string[]): Promise<ToolDefinition[]> {
    const skills = await this.getEnabledSkills(skillIds);
    return skills.flatMap((skill) => skill.tools);
  },
};

export const noopSkillsProvider: SkillsProvider = {
  async getEnabledSkills(): Promise<SkillDefinition[]> {
    return [];
  },

  async getEnabledSkillBlocks(): Promise<SkillPromptBlock[]> {
    return [];
  },

  async getEnabledTools(): Promise<ToolDefinition[]> {
    return [];
  },
};
