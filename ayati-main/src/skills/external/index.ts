import type { SkillPromptBlock } from "../types.js";
import type { ExternalSkillMeta } from "./types.js";

export type { ExternalSkillMeta, ExternalSkillManifest, ExternalSkillScanRoot } from "./types.js";
export { scanExternalSkills, stopExternalSkills } from "./scanner.js";
export { loadExternalSkillCatalog, buildExternalCapabilityDigest, searchExternalSkillCatalog, getExternalSkillById } from "./catalog.js";
export { createExternalSkillBroker, ExternalSkillBroker } from "./broker.js";
export {
  ExternalSkillRegistry,
  type ExternalSkillCard,
  type ExternalSkillDetail,
  type ExternalSkillRegistryOptions,
  type ExternalSkillSearchResult,
  type ExternalSkillToolSummary,
  type ExternalToolSearchResult,
  type QuarantinedExternalSkill,
} from "./registry.js";
export {
  RunExternalToolWindow,
  type LoadedExternalTool,
  type LoadedExternalToolResult,
  type RunExternalToolWindowOptions,
} from "./run-window.js";

export function buildExternalSkillsBlock(skills: ExternalSkillMeta[]): SkillPromptBlock {
  const lines = skills.map((s) => {
    const tag = s.installed ? "" : " [NOT INSTALLED]";
    const pluginPart = s.plugin ? `, plugin=${s.plugin}` : "";
    const sourcePart = `, source=${s.source}`;
    const commandPart = s.command ? `, command=${s.command}` : "";
    const aliasPart = s.aliases && s.aliases.length > 0 ? `, aliases=${s.aliases.join("|")}` : "";
    const examples = s.commands && s.commands.length > 0
      ? ` Examples: ${s.commands.slice(0, 3).map((command) => `\`${command}\``).join("; ")}`
      : "";
    return `- ${s.id} [type=${s.type}, runtime=${s.runtime}${pluginPart}${sourcePart}${commandPart}${aliasPart}] (${s.skillFilePath}) — ${s.description}${tag}${examples}`;
  });

  const content = `# External Skills

You have external skills installed on this system.

External skills are not built-in tools.
They are separate documented workflows or integrations that you may consult when a task depends on something beyond the built-in toolset.

Before using one or more external skills, first request a context search
only when the task itself is about broader project/session context rather than using a skill.
For normal external capability usage, inspect the visible skill cards and activate the needed skill through the controller's \`activate_skill\` directive.

The skill id is not always the same as the executable name.
When a skill entry includes command metadata, prefer that canonical command over guessing from the skill id.

If the needed capability is already present in Available Tools,
use that mounted tool directly instead of re-activating the skill.

Project-local skills override global skills with the same id.

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
