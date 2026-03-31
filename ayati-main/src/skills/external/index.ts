import type { SkillPromptBlock } from "../types.js";
import type { ExternalSkillMeta } from "./types.js";

export type { ExternalSkillMeta, ExternalSkillManifest } from "./types.js";
export { scanExternalSkills, stopExternalSkills } from "./scanner.js";

export function buildExternalSkillsBlock(skills: ExternalSkillMeta[]): SkillPromptBlock {
  const lines = skills.map((s) => {
    const tag = s.installed ? "" : " [NOT INSTALLED]";
    const pluginPart = s.plugin ? `, plugin=${s.plugin}` : "";
    return `- ${s.id} [type=${s.type}, runtime=${s.runtime}${pluginPart}] (${s.skillFilePath}) — ${s.description}${tag}`;
  });

  const content = `# External Skills

You have external skills installed on this system.

External skills are not built-in tools.
They are separate documented workflows or integrations that you may consult when a task depends on something beyond the built-in toolset.

Before using an external skill, first request a context search
with scope "skills" to load its full command reference from its skill.md file,
then use the documented commands or workflow.

If the needed capability is already present in Available Tools,
use the built-in tool directly instead of searching here.

Skill types:
- type=cli: commands are centered around an installed CLI.
- type=shell: commands may use general shell flows such as curl, bash, or other direct shell commands.

Skill runtimes:
- runtime=direct: the skill is documentation plus shell usage only.
- runtime=plugin: a long-running plugin is expected to provide runtime behavior such as webhook listeners.

Available skills:
${lines.join("\n")}`;

  return { id: "external-skills", content };
}
