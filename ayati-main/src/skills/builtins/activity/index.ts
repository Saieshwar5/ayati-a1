import type { ActivityStore } from "../../../memory/activity/index.js";
import type { ActivityThread } from "../../../memory/activity/types.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";

export interface ActivitySkillDeps {
  store: ActivityStore;
  defaultClientId?: string;
}

interface SearchInput {
  query: string;
  limit?: number;
}

interface ActivityIdInput {
  activityId: string;
}

interface UpdateInput {
  activityId: string;
  title?: string;
  summary?: string;
  openWork?: string[];
  verifiedFacts?: string[];
  nextStep?: string;
}

function createActivitySearchTool(deps: ActivitySkillDeps): ToolDefinition {
  return {
    name: "activity_search",
    description: "Search durable activity threads for prior work that may be continued.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Keywords, file path, document name, or topic to find." },
        limit: { type: "number", description: "Maximum matches, default 5." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["activity", "continuity", "prior work", "continue"],
      aliases: ["search activity", "find previous work", "continue previous task"],
      examples: ["continue the product website", "find the activity for site/index.html"],
      priority: 0.86,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseSearchInput(input);
      if ("ok" in parsed) return parsed;
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      const matches = deps.store.search(clientId, parsed.query, { limit: parsed.limit })
        .map(serializeActivityCandidate);
      return jsonResult({ matches });
    },
  };
}

function createActivityGetTool(deps: ActivitySkillDeps): ToolDefinition {
  return {
    name: "activity_get",
    description: "Get full details for one activity thread by id.",
    inputSchema: {
      type: "object",
      required: ["activityId"],
      properties: {
        activityId: { type: "string", description: "Activity thread id." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["activity", "details"],
      aliases: ["get activity", "inspect activity"],
      priority: 0.72,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseActivityIdInput(input);
      if ("ok" in parsed) return parsed;
      const activity = getOwnedActivity(deps, context, parsed.activityId);
      if (!activity) {
        return fail(`Activity not found: ${parsed.activityId}`);
      }
      return jsonResult({ activity: serializeActivity(activity) });
    },
  };
}

function createActivitySelectTool(deps: ActivitySkillDeps): ToolDefinition {
  return {
    name: "activity_select",
    description: "Select one ambiguous activity thread for the current task. Use only after continuity candidates are ambiguous or the user identifies a candidate.",
    inputSchema: {
      type: "object",
      required: ["activityId"],
      properties: {
        activityId: { type: "string", description: "Activity id to use for this task." },
        reason: { type: "string", description: "Short reason this activity is the selected continuation." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["activity", "select", "continue"],
      aliases: ["select activity", "choose activity", "resume activity"],
      priority: 0.82,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseActivityIdInput(input);
      if ("ok" in parsed) return parsed;
      const activity = getOwnedActivity(deps, context, parsed.activityId);
      if (!activity) {
        return fail(`Activity not found: ${parsed.activityId}`);
      }
      return jsonResult({
        selected: serializeActivity(activity),
        note: "Use this activityId in follow-up activity tools or activity_restore_assets calls in this action.",
      });
    },
  };
}

function createActivityUpdateTool(deps: ActivitySkillDeps): ToolDefinition {
  return {
    name: "activity_update",
    description: "Update an activity thread with corrected title, summary, open work, verified facts, or next step.",
    inputSchema: {
      type: "object",
      required: ["activityId"],
      properties: {
        activityId: { type: "string", description: "Activity id to update." },
        title: { type: "string", description: "Replacement title." },
        summary: { type: "string", description: "Replacement summary." },
        openWork: { type: "array", items: { type: "string" }, description: "Replacement open work list." },
        verifiedFacts: { type: "array", items: { type: "string" }, description: "Additional verified facts to append." },
        nextStep: { type: "string", description: "Replacement next step. Empty string clears it." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["activity", "update", "open work"],
      aliases: ["edit activity", "save next step", "update activity"],
      priority: 0.76,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseUpdateInput(input);
      if ("ok" in parsed) return parsed;
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      const activity = deps.store.updateActivity({ clientId, ...parsed });
      if (!activity) {
        return fail(`Activity not found: ${parsed.activityId}`);
      }
      return jsonResult({ updated: serializeActivity(activity) });
    },
  };
}

function createActivityArchiveTool(deps: ActivitySkillDeps): ToolDefinition {
  return {
    name: "activity_archive",
    description: "Archive an activity thread so it is hidden from automatic continuity resolution.",
    inputSchema: {
      type: "object",
      required: ["activityId"],
      properties: {
        activityId: { type: "string", description: "Activity id to archive." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["activity", "archive"],
      aliases: ["archive activity", "hide activity"],
      priority: 0.5,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseActivityIdInput(input);
      if ("ok" in parsed) return parsed;
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      return jsonResult({ archived: deps.store.archiveActivity(clientId, parsed.activityId) });
    },
  };
}

const ACTIVITY_PROMPT_BLOCK = [
  "Activity tools are built in.",
  "Activities are durable work threads with exact anchors such as file paths, document ids, directory ids, assets, aliases, runs, and open work.",
  "State view.context.continuity is the resolved continuity result. If mode is continue, use continuity.current as the current activity.",
  "If continuity.mode is ambiguous, ask the user to choose unless the user clearly identifies one candidate; then use activity_select or pass activityId to activity tools.",
  "Do not search or select an activity when continuity.mode is new and the user is starting unrelated work.",
].join("\n");

export function createActivitySkill(deps: ActivitySkillDeps): SkillDefinition {
  return {
    id: "activity",
    version: "1.0.0",
    description: "Search, select, update, and archive durable activity threads.",
    promptBlock: ACTIVITY_PROMPT_BLOCK,
    tools: [
      createActivitySearchTool(deps),
      createActivityGetTool(deps),
      createActivitySelectTool(deps),
      createActivityUpdateTool(deps),
      createActivityArchiveTool(deps),
    ],
  };
}

function parseSearchInput(input: unknown): SearchInput | ToolResult {
  if (!isRecord(input)) return fail("Invalid input: expected object.");
  const query = readString(input["query"]);
  if (!query) return fail("Invalid input: query is required.");
  return {
    query,
    limit: readLimit(input["limit"], 5),
  };
}

function parseActivityIdInput(input: unknown): ActivityIdInput | ToolResult {
  if (!isRecord(input)) return fail("Invalid input: expected object.");
  const activityId = readString(input["activityId"]) || readString(input["activity_id"]);
  if (!activityId) return fail("Invalid input: activityId is required.");
  return { activityId };
}

function parseUpdateInput(input: unknown): UpdateInput | ToolResult {
  const parsed = parseActivityIdInput(input);
  if ("ok" in parsed) return parsed;
  const record = isRecord(input) ? input : {};
  const openWork = readOptionalStringArray(record["openWork"], "openWork");
  if (isToolResult(openWork)) return openWork;
  const verifiedFacts = readOptionalStringArray(record["verifiedFacts"], "verifiedFacts");
  if (isToolResult(verifiedFacts)) return verifiedFacts;
  return {
    activityId: parsed.activityId,
    ...(readString(record["title"]) ? { title: readString(record["title"]) } : {}),
    ...(readString(record["summary"]) ? { summary: readString(record["summary"]) } : {}),
    ...(openWork ? { openWork } : {}),
    ...(verifiedFacts ? { verifiedFacts } : {}),
    ...(typeof record["nextStep"] === "string" ? { nextStep: record["nextStep"] } : {}),
  };
}

function getOwnedActivity(deps: ActivitySkillDeps, context: ToolExecutionContext | undefined, activityId: string): ActivityThread | null {
  const activity = deps.store.getActivity(activityId);
  if (!activity) return null;
  const clientId = context?.clientId ?? deps.defaultClientId;
  if (clientId && activity.clientId !== clientId) return null;
  return activity;
}

function clientIdFromContext(context: ToolExecutionContext | undefined, fallback?: string): string {
  return context?.clientId ?? fallback ?? "local";
}

function serializeActivityCandidate(activity: ActivityThread): Record<string, unknown> {
  return {
    activityId: activity.activityId,
    kind: activity.kind,
    title: activity.title,
    lifecycle: activity.lifecycle,
    summary: activity.summary,
    openWork: activity.state.openWork,
    nextStep: activity.state.nextStep,
    topAssets: topAssetLabels(activity),
    lastTouchedAt: activity.lastTouchedAt,
  };
}

function serializeActivity(activity: ActivityThread): Record<string, unknown> {
  return {
    activityId: activity.activityId,
    clientId: activity.clientId,
    kind: activity.kind,
    title: activity.title,
    summary: activity.summary,
    lifecycle: activity.lifecycle,
    identities: activity.identities,
    aliases: activity.aliases,
    assets: activity.assets,
    runs: activity.runs,
    state: activity.state,
    confidence: activity.confidence,
    importance: activity.importance,
    reuseCount: activity.reuseCount,
    createdAt: activity.createdAt,
    lastTouchedAt: activity.lastTouchedAt,
    autoLoadUntil: activity.autoLoadUntil,
    details: activity.details,
  };
}

function topAssetLabels(activity: ActivityThread): string[] {
  return activity.assets
    .map((asset) => asset.path ?? asset.displayName ?? asset.documentId ?? asset.fileId ?? asset.directoryId ?? asset.uri ?? "")
    .filter(Boolean)
    .slice(0, 5);
}

function readOptionalStringArray(value: unknown, fieldName: string): string[] | undefined | ToolResult {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return fail(`Invalid input: ${fieldName} must be an array of strings.`);
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return fail(`Invalid input: ${fieldName} must be an array of strings.`);
    }
    const trimmed = item.trim();
    if (trimmed) output.push(trimmed);
  }
  return output;
}

function readLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(20, Math.floor(value)))
    : fallback;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResult(value: unknown): value is ToolResult {
  return Boolean(value && typeof value === "object" && "ok" in value);
}

function jsonResult(value: unknown): ToolResult {
  return {
    ok: true,
    output: JSON.stringify(value, null, 2),
  };
}

function fail(error: string): ToolResult {
  return { ok: false, error };
}
