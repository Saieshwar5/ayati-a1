import calculatorSkill from "./builtins/calculator/index.js";
import databaseSkill from "./builtins/database/index.js";
import filesystemSkill from "./builtins/filesystem/index.js";
import processSkill from "./builtins/process/index.js";
import type { SkillDefinition } from "./types.js";

const BUILTIN_SKILLS: SkillDefinition[] = [processSkill, calculatorSkill, filesystemSkill, databaseSkill];

export const builtInSkillsProvider = {
  async getAllSkills(): Promise<SkillDefinition[]> {
    return BUILTIN_SKILLS;
  },
};
