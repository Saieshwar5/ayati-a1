import type { StaticContext } from "../context/static-context-cache.js";
import { renderBasePromptSection } from "../prompt/sections/base.js";
import { renderSoulSection } from "../prompt/sections/soul.js";

export function buildStaticSystemContext(staticContext: StaticContext | undefined): string | undefined {
  if (!staticContext) {
    return undefined;
  }

  return joinPromptSections([
    renderBasePromptSection(staticContext.basePrompt),
    renderSoulSection(staticContext.soul),
  ]);
}

function joinPromptSections(sections: Array<string | undefined>): string {
  return sections
    .filter((section): section is string => typeof section === "string" && section.trim().length > 0)
    .join("\n\n")
    .trim();
}
