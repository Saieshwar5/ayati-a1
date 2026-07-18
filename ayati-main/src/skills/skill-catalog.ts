import type { SkillDefinition, ToolDefinition, ToolDomain } from "./types.js";

export type SkillRisk = "read_only" | "workspace_mutating" | "external_mutating";
export type SkillActivationScope = "step" | "run" | "session";

export interface SkillCard {
  id: string;
  title: string;
  summary: string;
  domains: ToolDomain[];
  triggers: string[];
  whenToUse: string;
  notFor: string[];
  risk: SkillRisk;
  defaultScope: SkillActivationScope;
  toolsPreview: string[];
}

export interface SkillBundle {
  card: SkillCard;
  skill: SkillDefinition;
  tools: ToolDefinition[];
}

export interface SkillSearchResult {
  skillId: string;
  title: string;
  summary: string;
  whenToUse: string;
  domains: ToolDomain[];
  triggers: string[];
  toolsPreview: string[];
  score: number;
  matchReasons: string[];
}

const DEFAULT_SKILL_CARDS: Record<string, Partial<SkillCard>> = {
  calculator: {
    title: "Calculator",
    summary: "Evaluate deterministic math expressions.",
    domains: ["calculator"],
    triggers: ["calculate", "math", "sum", "average", "sqrt", "convert"],
    whenToUse: "Use for arithmetic, formulas, and deterministic numeric calculations.",
    notFor: ["Do not use for broad data analysis; activate python or datasets instead."],
    risk: "read_only",
    defaultScope: "step",
  },
  database: {
    title: "SQLite Database",
    summary: "Inspect and modify SQLite tables, rows, schema, and SQL queries.",
    domains: ["database"],
    triggers: ["database", "sqlite", "sql", "table", "rows", "schema", "query"],
    whenToUse: "Use when the task involves SQLite databases, tables, rows, schemas, or SQL statements.",
    notFor: ["Do not use for regular text files unless the file is a database."],
    risk: "workspace_mutating",
    defaultScope: "run",
  },
  pulse: {
    title: "Pulse",
    summary: "Create and manage reminders, schedules, and proactive follow-up items.",
    domains: ["pulse"],
    triggers: ["remind", "reminder", "schedule", "tomorrow", "daily", "weekly", "snooze"],
    whenToUse: "Use when the user asks for reminders, recurring schedules, or proactive follow-up.",
    notFor: ["Do not use for normal calendar analysis unless it is represented as a Pulse item."],
    risk: "workspace_mutating",
    defaultScope: "run",
  },
  recall: {
    title: "Recall",
    summary: "Search episodic memory and inspect memory subsystem status.",
    domains: ["recall", "memory"],
    triggers: ["remember", "recall", "previously", "last time", "what did i say", "history"],
    whenToUse: "Use to search prior conversation/task memory or inspect episodic memory status.",
    notFor: ["Do not use for saving new personal facts; activate memory instead."],
    risk: "read_only",
    defaultScope: "run",
  },
  memory: {
    title: "Personal Memory",
    summary: "Search, save, forget, explain, and give feedback on durable personal memories.",
    domains: ["memory"],
    triggers: ["remember this", "save this", "forget", "my preference", "about me"],
    whenToUse: "Use when the user asks to save, update, inspect, or forget durable personal facts/preferences.",
    notFor: ["Do not use for temporary task state; use task progress instead."],
    risk: "workspace_mutating",
    defaultScope: "run",
  },
  python: {
    title: "Python",
    summary: "Run managed Python for analysis, transformations, charts, and dataset inspection.",
    domains: ["python"],
    triggers: ["python", "analyze", "chart", "plot", "statistics", "dataframe", "transform"],
    whenToUse: "Use for computation-heavy analysis, plotting, data transformation, or custom scripts.",
    notFor: ["Do not use for simple shell commands or direct file edits."],
    risk: "workspace_mutating",
    defaultScope: "run",
  },
  attachments: {
    title: "Attachments",
    summary: "Restore prior file, directory, document, and dataset attachments into the current run.",
    domains: ["attachments"],
    triggers: ["attachment", "upload", "attached", "file context", "restore attachment", "same document", "that file", "that directory"],
    whenToUse: "Use when the current task continues from user-provided or previously used attachments.",
    notFor: ["Do not use for arbitrary filesystem paths; use files or filesystem tools."],
    risk: "read_only",
    defaultScope: "run",
  },
  datasets: {
    title: "Datasets",
    summary: "Profile, query, and promote structured tabular prepared attachments.",
    domains: ["datasets"],
    triggers: ["csv", "xlsx", "dataset", "table", "columns", "rows", "profile", "query table"],
    whenToUse: "Use for structured attachments such as CSV/XLSX tables and dataset queries.",
    notFor: ["Do not use for prose documents; activate documents instead."],
    risk: "workspace_mutating",
    defaultScope: "run",
  },
  documents: {
    title: "Documents",
    summary: "List, read, and query sections from prepared prose documents.",
    domains: ["documents"],
    triggers: ["pdf", "docx", "document", "section", "summarize", "citation", "source"],
    whenToUse: "Use for uploaded PDFs, DOCX, text documents, section reads, and document retrieval.",
    notFor: ["Do not use for structured CSV/XLSX analysis; activate datasets instead."],
    risk: "read_only",
    defaultScope: "run",
  },
  "git-context": {
    title: "Git Context",
    summary: "Inspect Ayati session context, V1 task repositories, requests, and recent task evidence.",
    domains: ["git_context"],
    triggers: ["git context", "task repository", "task request", "active task", "session context", "previous task"],
    whenToUse: "Use when the agent needs to inspect durable session context, task candidates, a selected V1 task repository, or request history.",
    notFor: ["Do not use read-only inspection tools for task selection, commits, finalization, or editing user files."],
    risk: "read_only",
    defaultScope: "run",
  },
  files: {
    title: "Managed Files",
    summary: "Inspect, register, read, query, and profile managed attached files/directories.",
    domains: ["files", "attachments"],
    triggers: ["attached file", "managed file", "upload", "directory attachment", "file query", "attachment query", "read attachment"],
    whenToUse: "Use for current-run and restored files/directories through the unified attachment tools.",
    notFor: ["Do not use for direct workspace file edits; use filesystem tools."],
    risk: "workspace_mutating",
    defaultScope: "run",
  },
  "ui-workspace": {
    title: "UI Workspace",
    summary: "Control the current CLI-anchored workspace and visual windows.",
    domains: ["ui"],
    triggers: ["open window", "show", "focus", "layout", "workspace", "browser", "preview"],
    whenToUse: "Use when the task requires opening, arranging, focusing, or inspecting UI windows.",
    notFor: ["Do not use for non-visual background work."],
    risk: "workspace_mutating",
    defaultScope: "run",
  },
};

export class SkillCatalog {
  private readonly bundles = new Map<string, SkillBundle>();

  constructor(bundles: SkillBundle[]) {
    for (const bundle of bundles) {
      this.bundles.set(bundle.card.id, bundle);
    }
  }

  listCards(): SkillCard[] {
    return [...this.bundles.values()].map((bundle) => cloneCard(bundle.card));
  }

  getBundle(skillId: string): SkillBundle | undefined {
    return this.bundles.get(skillId);
  }

  getCard(skillId: string): SkillCard | undefined {
    const card = this.bundles.get(skillId)?.card;
    return card ? cloneCard(card) : undefined;
  }

  search(query: string, limit = 5): SkillSearchResult[] {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const tokens = tokenize(query);
    return this.listCards()
      .map((card) => scoreCard(card, tokens, query))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.skillId.localeCompare(right.skillId))
      .slice(0, normalizedLimit);
  }

  promptBlock(): string {
    const cards = this.listCards();
    if (cards.length === 0) {
      return "No dynamic built-in skills are registered.";
    }

    return [
      "Dynamic built-in skills are available as compact cards.",
      "Use skill_activate when a card clearly matches the current task and full tool schemas are needed.",
      "Inactive skills are not directly callable until activated.",
      "",
      ...cards.map((card) => [
        `- ${card.id}: ${card.summary}`,
        `  whenToUse=${card.whenToUse}`,
        `  triggers=${card.triggers.slice(0, 10).join(", ")}`,
        `  toolsPreview=${card.toolsPreview.slice(0, 8).join(", ")}`,
        `  risk=${card.risk}; defaultScope=${card.defaultScope}`,
      ].join("\n")),
    ].join("\n");
  }
}

export function createSkillBundle(skill: SkillDefinition, cardOverrides: Partial<SkillCard> = {}): SkillBundle {
  const defaults = DEFAULT_SKILL_CARDS[skill.id] ?? {};
  const toolsPreview = skill.tools.map((tool) => tool.name);
  const domains = inferDomains(skill.tools, defaults.domains);
  const card: SkillCard = {
    id: skill.id,
    title: cardOverrides.title ?? defaults.title ?? skill.id,
    summary: cardOverrides.summary ?? defaults.summary ?? skill.description,
    domains: cardOverrides.domains ?? domains,
    triggers: cardOverrides.triggers ?? defaults.triggers ?? inferTriggers(skill),
    whenToUse: cardOverrides.whenToUse ?? defaults.whenToUse ?? skill.description,
    notFor: cardOverrides.notFor ?? defaults.notFor ?? [],
    risk: cardOverrides.risk ?? defaults.risk ?? inferRisk(skill.tools),
    defaultScope: cardOverrides.defaultScope ?? defaults.defaultScope ?? "run",
    toolsPreview: cardOverrides.toolsPreview ?? toolsPreview,
  };

  return {
    card,
    skill,
    tools: [...skill.tools],
  };
}

function inferDomains(tools: ToolDefinition[], defaults?: ToolDomain[]): ToolDomain[] {
  const domains = new Set<ToolDomain>(defaults ?? []);
  for (const tool of tools) {
    if (tool.annotations?.domain) {
      domains.add(tool.annotations.domain);
    }
  }
  return domains.size > 0 ? [...domains] : ["general"];
}

function inferRisk(tools: ToolDefinition[]): SkillRisk {
  if (tools.some((tool) => tool.annotations?.mutatesExternalWorld)) {
    return "external_mutating";
  }
  if (tools.some((tool) => tool.annotations?.mutatesWorkspace || tool.annotations?.destructive)) {
    return "workspace_mutating";
  }
  return "read_only";
}

function inferTriggers(skill: SkillDefinition): string[] {
  return [
    skill.id,
    ...skill.description.split(/[^a-z0-9_-]+/i),
    ...skill.tools.flatMap((tool) => [
      tool.name,
      ...(tool.selectionHints?.tags ?? []),
      ...(tool.selectionHints?.aliases ?? []),
    ]),
  ]
    .map((value) => value.trim().toLowerCase())
    .filter((value, index, values) => value.length > 1 && values.indexOf(value) === index)
    .slice(0, 16);
}

function scoreCard(card: SkillCard, tokens: Set<string>, query: string): SkillSearchResult {
  const haystackValues = [
    card.id,
    card.title,
    card.summary,
    card.whenToUse,
    ...card.domains,
    ...card.triggers,
    ...card.toolsPreview,
  ];
  const haystack = haystackValues.join(" ").toLowerCase();
  const matchReasons: string[] = [];
  let score = 0;

  if (query.toLowerCase().includes(card.id.toLowerCase())) {
    score += 25;
    matchReasons.push("matched skill id");
  }

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length > 4 ? 4 : 2;
      matchReasons.push(`matched ${token}`);
    }
  }

  return {
    skillId: card.id,
    title: card.title,
    summary: card.summary,
    whenToUse: card.whenToUse,
    domains: [...card.domains],
    triggers: [...card.triggers],
    toolsPreview: [...card.toolsPreview],
    score,
    matchReasons: [...new Set(matchReasons)].slice(0, 8),
  };
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}

function cloneCard(card: SkillCard): SkillCard {
  return {
    ...card,
    domains: [...card.domains],
    triggers: [...card.triggers],
    notFor: [...card.notFor],
    toolsPreview: [...card.toolsPreview],
  };
}
