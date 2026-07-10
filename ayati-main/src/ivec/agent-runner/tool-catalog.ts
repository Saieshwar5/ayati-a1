import type { SkillDefinition, ToolDefinition, ToolDomain } from "../../skills/types.js";
import {
  getToolLoadGroups,
  getToolNextOnFailure,
  getToolNextOnSuccess,
  getToolTaxonomy,
} from "../../skills/tool-taxonomy.js";

export type ToolDeactivationPolicy = "manual" | "one_step" | "success" | "task";

export interface ToolCatalogEntry {
  id: string;
  name: string;
  skillId: string;
  description: string;
  groups: string[];
  aliases: string[];
  examples: string[];
  requires: string[];
  produces: string[];
  deactivationPolicy: ToolDeactivationPolicy;
  nextOnSuccess: string[];
  nextOnFailure: string[];
  tool: ToolDefinition;
}

export interface ToolSearchResult {
  entry: ToolCatalogEntry;
  score: number;
  reasons: string[];
}

export class ToolCatalog {
  private readonly byName = new Map<string, ToolCatalogEntry>();
  private readonly byId = new Map<string, ToolCatalogEntry>();
  private readonly byGroup = new Map<string, ToolCatalogEntry[]>();
  private readonly skillSummaries = new Map<string, string>();

  constructor(skills: SkillDefinition[]) {
    for (const skill of skills) {
      this.skillSummaries.set(skill.id, skill.description);
      for (const tool of skill.tools) {
        const entry = buildEntry(skill, tool);
        this.byName.set(entry.name, entry);
        this.byId.set(entry.id, entry);
        for (const group of entry.groups) {
          const current = this.byGroup.get(group) ?? [];
          current.push(entry);
          this.byGroup.set(group, current);
        }
      }
    }
  }

  get(nameOrId: string): ToolCatalogEntry | undefined {
    return this.byName.get(nameOrId) ?? this.byId.get(nameOrId);
  }

  getTool(nameOrId: string): ToolDefinition | undefined {
    return this.get(nameOrId)?.tool;
  }

  list(): ToolCatalogEntry[] {
    return [...this.byName.values()];
  }

  groupNames(): string[] {
    return [...this.byGroup.keys()].sort();
  }

  groupSummaries(limit = 80): string[] {
    return this.groupNames()
      .filter((group) => isPromptGroup(group))
      .slice(0, limit)
      .map((group) => {
        const tools = this.toolsForGroup(group).slice(0, 6).map((entry) => entry.name);
        return `${group}: ${tools.join(", ")}`;
      });
  }

  toolsForGroup(group: string): ToolCatalogEntry[] {
    return [...(this.byGroup.get(group) ?? [])];
  }

  search(query: string, limit = 8): ToolSearchResult[] {
    const tokens = tokenize(query);
    const normalized = query.toLowerCase();
    return this.list()
      .map((entry) => scoreEntry(entry, tokens, normalized))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
      .slice(0, Math.max(1, Math.floor(limit)));
  }

  promptSummary(maxSkills = 24): string {
    const skills = [...this.skillSummaries.entries()]
      .slice(0, maxSkills)
      .map(([id, description]) => {
        const representativeTools = this.list()
          .filter((entry) => entry.skillId === id)
          .slice(0, 5)
          .map((entry) => entry.name);
        const toolText = representativeTools.length > 0
          ? ` Representative tools: ${representativeTools.join(", ")}.`
          : "";
        return `- ${id}: ${description}${toolText}`;
      });
    return [
      "Hidden tools are loaded by returning load_tools when selected tools are insufficient.",
      "load_tools must include at least one selector: groups, toolNames, or query.",
      "Prefer 1-3 small purpose-built groups together instead of one broad group.",
      `Loadable groups:\n${this.groupSummaries().map((line) => `- ${line}`).join("\n") || "- (none)"}.`,
      "Skill summaries:",
      ...skills,
    ].join("\n");
  }
}

function buildEntry(skill: SkillDefinition, tool: ToolDefinition): ToolCatalogEntry {
  const domain = tool.annotations?.domain ?? tool.selectionHints?.domain;
  const taxonomyGroups = getToolLoadGroups(tool.name);
  const groups = uniqueStrings([
    `skill:${skill.id}`,
    skill.id,
    ...(domain ? [`domain:${domain}`, domain] : []),
    ...(taxonomyGroups.length > 0 ? taxonomyGroups : [
      ...operationGroups(tool),
      ...artifactGroups(tool),
      ...workflowGroups(skill.id, domain),
    ]),
    ...workflowGroupsFromTaxonomy(taxonomyGroups),
    ...(tool.selectionHints?.tags ?? []).map((tag) => `tag:${tag}`),
  ]);

  const next = taxonomyNextTools(tool.name) ?? inferNextTools(tool.name);
  return {
    id: `${skill.id}.${tool.name}`,
    name: tool.name,
    skillId: skill.id,
    description: tool.description,
    groups,
    aliases: uniqueStrings([
      ...(tool.selectionHints?.aliases ?? []),
      tool.name.replace(/_/g, " "),
      tool.name.replace(/[._]/g, " "),
    ]),
    examples: tool.selectionHints?.examples ?? [],
    requires: inferRequires(tool),
    produces: inferProduces(tool),
    deactivationPolicy: inferDeactivationPolicy(tool),
    nextOnSuccess: next.success,
    nextOnFailure: next.failure,
    tool,
  };
}

function isPromptGroup(group: string): boolean {
  return group.includes(":") && !group.startsWith("tag:");
}

function workflowGroupsFromTaxonomy(groups: string[]): string[] {
  const values = new Set(groups);
  const result: string[] = [];
  if (values.has("file:read") || values.has("file:write") || values.has("file:refactor") || values.has("shell:command")) {
    result.push("workflow:code_edit", "workflow:static_site");
  }
  if (values.has("attachment:basic") || values.has("document:qa")) {
    result.push("workflow:attachment_work", "workflow:document_qa");
  }
  if (values.has("data:inspect") || values.has("data:execute")) {
    result.push("workflow:data_analysis");
  }
  if (values.has("ui:workspace")) {
    result.push("workflow:ui_workspace");
  }
  return result;
}

function taxonomyNextTools(toolName: string): { success: string[]; failure: string[] } | undefined {
  const success = getToolNextOnSuccess(toolName);
  const failure = getToolNextOnFailure(toolName);
  if (success.length === 0 && failure.length === 0) {
    return undefined;
  }
  return { success, failure };
}

function scoreEntry(entry: ToolCatalogEntry, tokens: Set<string>, query: string): ToolSearchResult {
  let score = 0;
  const reasons: string[] = [];
  const haystack = [
    entry.id,
    entry.name,
    entry.description,
    entry.skillId,
    ...entry.groups,
    ...entry.aliases,
    ...entry.examples,
    ...entry.requires,
    ...entry.produces,
  ].join(" ").toLowerCase();

  if (query.includes(entry.name.toLowerCase()) || query.includes(entry.id.toLowerCase())) {
    score += 30;
    reasons.push("exact tool match");
  }
  for (const group of entry.groups) {
    if (query.includes(group.toLowerCase())) {
      score += 18;
      reasons.push(`group ${group}`);
    }
  }
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length > 4 ? 4 : 1;
    }
  }
  if (score > 0 && entry.tool.selectionHints?.priority) {
    score += Math.min(10, entry.tool.selectionHints.priority);
  }
  return { entry, score, reasons };
}

function operationGroups(tool: ToolDefinition): string[] {
  const text = `${tool.name} ${tool.description}`.toLowerCase();
  const groups: string[] = [];
  const checks: Array<[string, string[]]> = [
    ["operation:search", ["search", "find", "query"]],
    ["operation:read", ["read", "list", "inspect", "describe", "profile", "status", "get"]],
    ["operation:write", ["write", "create", "edit", "update", "insert", "add", "register", "promote"]],
    ["operation:execute", ["run", "execute", "shell", "python"]],
    ["operation:delete", ["delete", "drop", "remove", "archive", "close"]],
    ["operation:restore", ["restore", "attachment"]],
    ["operation:ui", ["window", "workspace", "focus", "layout", "show", "open"]],
  ];
  for (const [group, terms] of checks) {
    if (terms.some((term) => text.includes(term))) {
      groups.push(group);
    }
  }
  return groups;
}

function artifactGroups(tool: ToolDefinition): string[] {
  const text = `${tool.name} ${tool.description}`.toLowerCase();
  const groups: string[] = [];
  const checks: Array<[string, string[]]> = [
    ["artifact:file", ["file", "path", "source"]],
    ["artifact:directory", ["directory", "folder"]],
    ["artifact:document", ["document", "pdf", "docx", "section"]],
    ["artifact:dataset", ["dataset", "csv", "xlsx", "table", "rows"]],
    ["artifact:database", ["database", "sqlite", "sql", "table"]],
    ["artifact:evidence", ["evidence", "tool output", "raw output"]],
    ["artifact:window", ["window", "workspace", "browser"]],
    ["artifact:memory", ["memory", "recall", "activity"]],
  ];
  for (const [group, terms] of checks) {
    if (terms.some((term) => text.includes(term))) {
      groups.push(group);
    }
  }
  return groups;
}

function workflowGroups(skillId: string, domain?: ToolDomain | string): string[] {
  const values = new Set([skillId, domain].filter((value): value is string => Boolean(value)));
  const groups: string[] = [];
  if (values.has("filesystem") || values.has("shell") || values.has("python")) {
    groups.push("workflow:code_edit", "workflow:test_debug");
  }
  if (values.has("documents") || values.has("attachments") || values.has("files")) {
    groups.push("workflow:document_qa", "workflow:attachment_work");
  }
  if (values.has("datasets") || values.has("database") || values.has("python")) {
    groups.push("workflow:data_analysis");
  }
  if (values.has("ui") || values.has("ui-workspace")) {
    groups.push("workflow:ui_workspace");
  }
  return groups;
}

function inferRequires(tool: ToolDefinition): string[] {
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  const properties = (schema?.["properties"] ?? {}) as Record<string, unknown>;
  return Object.keys(properties).filter((key) => /path|file|document|dataset|table|query|id|ref|window|course|lesson/i.test(key));
}

function inferProduces(tool: ToolDefinition): string[] {
  const text = `${tool.name} ${tool.description}`.toLowerCase();
  return [
    text.includes("evidence") ? "evidence" : "",
    text.includes("file") ? "file" : "",
    text.includes("document") ? "document" : "",
    text.includes("dataset") || text.includes("table") ? "table" : "",
    text.includes("window") || text.includes("workspace") ? "window" : "",
  ].filter((item) => item.length > 0);
}

function inferNextTools(toolName: string): { success: string[]; failure: string[] } {
  const map: Record<string, { success: string[]; failure: string[] }> = {
    find_files: { success: ["read_files", "patch_files", "write_files"], failure: ["list_directory", "search_in_files"] },
    search_in_files: { success: ["read_files", "patch_files"], failure: ["find_files", "list_directory"] },
    read_files: { success: ["patch_files", "write_files", "search_in_files"], failure: ["find_files", "list_directory"] },
    patch_files: { success: ["read_files", "shell_run_script"], failure: ["read_files", "search_in_files", "write_files"] },
    write_files: { success: ["read_files", "shell_run_script"], failure: ["create_directory", "write_files"] },
    shell: { success: ["search_in_files", "read_files"], failure: ["search_in_files", "read_files"] },
    shell_run_script: { success: ["search_in_files", "read_files"], failure: ["search_in_files", "read_files"] },
    attachment_restore: { success: ["attachment_list", "attachment_read", "document_query", "dataset_profile"], failure: ["attachment_list"] },
    restore_attachment_context: { success: ["attachment_list", "attachment_read", "document_query", "dataset_profile"], failure: ["attachment_list"] },
    document_query: { success: ["document_read_section"], failure: ["document_list_sections", "attachment_query"] },
    document_list_sections: { success: ["document_read_section", "document_query"], failure: ["attachment_query"] },
    dataset_profile: { success: ["dataset_query", "python_execute"], failure: ["attachment_query_table", "file_profile_table"] },
    dataset_query: { success: ["python_execute"], failure: ["dataset_profile", "file_query_table"] },
    python_inspect_dataset: { success: ["python_execute"], failure: ["dataset_profile"] },
  };
  return map[toolName] ?? { success: [], failure: [] };
}

function inferDeactivationPolicy(tool: ToolDefinition): ToolDeactivationPolicy {
  const taxonomy = getToolTaxonomy(tool.name);
  if (taxonomy) {
    switch (taxonomy.lifetime) {
      case "single_use":
        return "success";
      case "one_step":
        return "one_step";
      case "phase":
      case "run":
      case "session":
      case "background":
        return "task";
    }
  }
  const name = tool.name;
  if (name === "find_files" || name === "attachment_restore" || name === "restore_attachment_context") {
    return "success";
  }
  if (tool.annotations?.destructive || /^db_drop_|^delete$/.test(name)) {
    return "one_step";
  }
  return "task";
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9_./:-]+/g).map((token) => token.trim()).filter((token) => token.length > 1));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)).map((value) => value.trim()))];
}
