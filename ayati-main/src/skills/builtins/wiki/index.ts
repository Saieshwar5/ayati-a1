import type { UserProfileContext } from "../../../context/types.js";
import { UserWikiStore } from "../../../context/wiki-store.js";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

interface WikiSearchInput {
  query: string;
  limit?: number;
}

interface WikiReadSectionInput {
  section: string;
}

interface WikiUpdateInput {
  section: string;
  mode?: "append" | "replace";
  content: string;
}

function validateObject(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" ? input as Record<string, unknown> : null;
}

export interface WikiSkillDeps {
  wikiStore: UserWikiStore;
  onProfileUpdated: (profile: UserProfileContext) => void;
}

function createListSectionsTool(deps: WikiSkillDeps): ToolDefinition {
  return {
    name: "wiki_list_sections",
    description: "List available user wiki sections and whether they currently contain information.",
    inputSchema: { type: "object", properties: {} },
    async execute(): Promise<ToolResult> {
      const sections = await deps.wikiStore.listSections();
      return { ok: true, output: JSON.stringify({ sections }, null, 2) };
    },
  };
}

function createSearchTool(deps: WikiSkillDeps): ToolDefinition {
  return {
    name: "wiki_search",
    description: "Search the user wiki and return matching sections with compact snippets.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Text to search for in the user wiki." },
        limit: { type: "number", description: "Maximum number of matches to return (default 5, max 8)." },
      },
    },
    async execute(input): Promise<ToolResult> {
      const value = validateObject(input);
      if (!value || typeof value["query"] !== "string" || value["query"].trim().length === 0) {
        return { ok: false, error: "Invalid input: query must be a non-empty string." };
      }
      const limit = typeof value["limit"] === "number" ? value["limit"] : undefined;
      const matches = await deps.wikiStore.search(value["query"].trim(), limit);
      return { ok: true, output: JSON.stringify({ matches }, null, 2) };
    },
  };
}

function createReadSectionTool(deps: WikiSkillDeps): ToolDefinition {
  return {
    name: "wiki_read_section",
    description: "Read a specific section from the user wiki.",
    inputSchema: {
      type: "object",
      required: ["section"],
      properties: {
        section: { type: "string", description: "Exact wiki section name to read." },
      },
    },
    async execute(input): Promise<ToolResult> {
      const value = validateObject(input);
      if (!value || typeof value["section"] !== "string" || value["section"].trim().length === 0) {
        return { ok: false, error: "Invalid input: section must be a non-empty string." };
      }
      try {
        const section = await deps.wikiStore.readSection(value["section"].trim());
        return {
          ok: true,
          output: JSON.stringify({ section: section.schema.name, kind: section.schema.kind, content: section.content }, null, 2),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function createUpdateTool(deps: WikiSkillDeps): ToolDefinition {
  return {
    name: "wiki_update",
    description: "Update a user wiki section. Use when the user explicitly asks to save, correct, or remember something.",
    inputSchema: {
      type: "object",
      required: ["section", "content"],
      properties: {
        section: { type: "string", description: "Wiki section to update." },
        mode: { type: "string", description: "append (default) or replace the section content." },
        content: { type: "string", description: "Section content to append or replace with." },
      },
    },
    async execute(input): Promise<ToolResult> {
      const value = validateObject(input);
      if (!value) {
        return { ok: false, error: "Invalid input: expected object." };
      }
      const section = typeof value["section"] === "string" ? value["section"].trim() : "";
      const content = typeof value["content"] === "string" ? value["content"].trim() : "";
      if (section.length === 0) {
        return { ok: false, error: "Invalid input: section must be a non-empty string." };
      }
      if (content.length === 0) {
        return { ok: false, error: "Invalid input: content must be a non-empty string." };
      }
      const mode = value["mode"] === "replace" ? "replace" : "append";
      try {
        const updated = await deps.wikiStore.updateSection(section, mode, content);
        deps.onProfileUpdated(updated.profile);
        return {
          ok: true,
          output: JSON.stringify({ section, mode, updatedAt: updated.wiki.lastUpdated }, null, 2),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const WIKI_PROMPT_BLOCK = [
  "The user wiki tools are built in.",
  "The wiki is a durable personal knowledge base for the user. It is richer than the always-loaded user profile.",
  "Use wiki_search when you need user-specific background but do not yet know which section matters.",
  "Use wiki_read_section once the relevant section is known.",
  "Use wiki_list_sections when you need the available wiki structure first.",
  "Do not read the wiki for generic tasks that do not benefit from personalization.",
  "Use wiki_update only when the user explicitly asks you to save, correct, or remember information.",
].join("\n");

export function createWikiSkill(deps: WikiSkillDeps): SkillDefinition {
  return {
    id: "wiki",
    version: "1.0.0",
    description: "Read and maintain the user's durable personal wiki.",
    promptBlock: WIKI_PROMPT_BLOCK,
    tools: [
      createListSectionsTool(deps),
      createSearchTool(deps),
      createReadSectionTool(deps),
      createUpdateTool(deps),
    ],
  };
}
