import type { StaticContext } from "../context/static-context-cache.js";
import { renderBasePromptSection } from "../prompt/sections/base.js";
import { renderSkillsSection } from "../prompt/sections/skills.js";
import { renderSoulSection } from "../prompt/sections/soul.js";

export function buildStaticSystemContext(staticContext: StaticContext | undefined): string | undefined {
  if (!staticContext) {
    return undefined;
  }

  return joinPromptSections([
    renderBasePromptSection(staticContext.basePrompt),
    renderSoulSection(staticContext.soul),
    renderSkillsSection(staticContext.skillBlocks),
    renderToolDirectorySection(
      staticContext.toolDirectory,
      process.env["PROMPT_INCLUDE_TOOL_DIRECTORY"] === "1",
    ),
  ]);
}

function joinPromptSections(sections: Array<string | undefined>): string {
  return sections
    .filter((section): section is string => typeof section === "string" && section.trim().length > 0)
    .join("\n\n")
    .trim();
}

function renderToolDirectorySection(toolDirectory: string | undefined, includeToolDirectory: boolean): string {
  if (!includeToolDirectory) return "";
  if (!toolDirectory || toolDirectory.trim().length === 0) return "";
  return `# Available Tools\n\n${toolDirectory}`;
}
