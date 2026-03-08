import type { SkillPromptBlock } from "../types.js";
import type { ExternalSkillMeta } from "./types.js";

export type { ExternalSkillMeta, ExternalSkillManifest } from "./types.js";
export { scanExternalSkills, stopExternalSkills } from "./scanner.js";

export function buildExternalSkillsBlock(skills: ExternalSkillMeta[]): SkillPromptBlock {
  const lines = skills.map((s) => {
    const tag = s.installed ? "" : " [NOT INSTALLED]";
    return `- ${s.id} (${s.skillFilePath}) — ${s.description}${tag}`;
  });

  const content = `# External Skills

You have external CLI-based skills installed on this system.
When you need to use an external skill, request a context search
with scope "skills" to load its full command reference from its skill.md file,
then use the shell tool to execute the CLI commands.

Available skills:
${lines.join("\n")}`;

  return { id: "external-skills", content };
}
