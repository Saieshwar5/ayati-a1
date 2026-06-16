import type { FocusCard, FocusScope, FocusShelfItem, FocusStore } from "../../../memory/focus/index.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";

export interface FocusSkillDeps {
  store: FocusStore;
  defaultClientId?: string;
}

type FocusSearchScope = FocusScope | "all";

interface FocusSearchInput {
  query: string;
  scope?: FocusSearchScope;
  limit?: number;
}

interface FocusIdInput {
  focusId: string;
}

interface FocusActivateInput {
  focusId: string;
  reason?: string;
}

interface FocusUpdateInput {
  focusId: string;
  summary?: string;
  openWork?: string[];
  verifiedFacts?: string[];
  nextStep?: string;
}

interface FocusListInput {
  limit?: number;
  scope?: FocusSearchScope;
}

interface FocusDeactivateInput {
  focusId?: string;
}

function createFocusSearchTool(deps: FocusSkillDeps): ToolDefinition {
  return {
    name: "focus_search",
    description: "Search session and attention-shelf focus cards for reusable prior work.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Keywords for the work, artifact, topic, or open issue to find." },
        scope: { type: "string", enum: ["session", "global", "all"], description: "Search current session cards, global attention shelf cards, or both." },
        limit: { type: "number", description: "Maximum matches, default 5." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["focus", "attention", "prior work", "continue"],
      aliases: ["search focus cards", "find previous task", "attention shelf search"],
      examples: ["continue the last project", "find the focus card for this file", "reactivate previous debugging work"],
      priority: 0.82,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseSearchInput(input);
      if ("ok" in parsed) return parsed;
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      if (parsed.scope === "session" && !context?.sessionId) {
        return fail("focus_search with scope=session requires an active session.");
      }
      const matches = deps.store.search(clientId, parsed.query, {
        scope: parsed.scope ?? "all",
        sessionId: parsed.scope === "session" ? context?.sessionId : undefined,
        limit: parsed.limit,
      });
      return jsonResult({ matches });
    },
  };
}

function createFocusGetTool(deps: FocusSkillDeps): ToolDefinition {
  return {
    name: "focus_get",
    description: "Get full details for one focus card by id.",
    inputSchema: {
      type: "object",
      required: ["focusId"],
      properties: {
        focusId: { type: "string", description: "Focus card id." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["focus", "details"],
      aliases: ["get focus card", "inspect focus card"],
      priority: 0.72,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseFocusIdInput(input);
      if ("ok" in parsed) return parsed;
      const card = getOwnedFocusCard(deps, context, parsed.focusId);
      if (!card) {
        return fail(`Focus card not found: ${parsed.focusId}`);
      }
      return jsonResult({ focus: serializeFocusCard(card) });
    },
  };
}

function createFocusActivateTool(deps: FocusSkillDeps): ToolDefinition {
  return {
    name: "focus_activate",
    description: "Mark a focus card as active for the current session so it appears in activeFocus context.",
    inputSchema: {
      type: "object",
      required: ["focusId"],
      properties: {
        focusId: { type: "string", description: "Focus card id to activate." },
        reason: { type: "string", description: "Short reason the card is relevant now." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["focus", "activate", "continue"],
      aliases: ["reactivate focus card", "resume focus", "use previous focus"],
      priority: 0.9,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseActivateInput(input);
      if ("ok" in parsed) return parsed;
      if (!context?.sessionId) {
        return fail("focus_activate requires an active session.");
      }
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      const card = deps.store.activateFocus({
        clientId,
        focusId: parsed.focusId,
        sessionId: context.sessionId,
        reason: parsed.reason,
      });
      if (!card) {
        return fail(`Focus card not found: ${parsed.focusId}`);
      }
      return jsonResult({ activated: serializeFocusCard(card) });
    },
  };
}

function createFocusDeactivateTool(deps: FocusSkillDeps): ToolDefinition {
  return {
    name: "focus_deactivate",
    description: "Remove one or all active focus cards from the current session.",
    inputSchema: {
      type: "object",
      properties: {
        focusId: { type: "string", description: "Optional focus id. Omit to deactivate all cards for this session." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["focus", "deactivate"],
      aliases: ["clear active focus", "stop using focus card"],
      priority: 0.52,
    },
    async execute(input, context): Promise<ToolResult> {
      if (!context?.sessionId) {
        return fail("focus_deactivate requires an active session.");
      }
      const parsed = parseDeactivateInput(input);
      if ("ok" in parsed) return parsed;
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      const deactivated = deps.store.deactivateFocus(clientId, context.sessionId, parsed.focusId);
      return jsonResult({ deactivated });
    },
  };
}

function createFocusUpdateTool(deps: FocusSkillDeps): ToolDefinition {
  return {
    name: "focus_update",
    description: "Update a focus card with corrected summary, open work, verified facts, or next step.",
    inputSchema: {
      type: "object",
      required: ["focusId"],
      properties: {
        focusId: { type: "string", description: "Focus card id to update." },
        summary: { type: "string", description: "Replacement concise summary." },
        openWork: { type: "array", items: { type: "string" }, description: "Replacement open work list." },
        verifiedFacts: { type: "array", items: { type: "string" }, description: "Additional verified facts to append." },
        nextStep: { type: "string", description: "Replacement next step. Empty string clears it." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["focus", "update", "open work"],
      aliases: ["edit focus card", "save next step", "update active focus"],
      priority: 0.78,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseUpdateInput(input);
      if ("ok" in parsed) return parsed;
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      const card = deps.store.updateFocus({ clientId, ...parsed });
      if (!card) {
        return fail(`Focus card not found: ${parsed.focusId}`);
      }
      return jsonResult({ updated: serializeFocusCard(card) });
    },
  };
}

function createFocusListSessionTool(deps: FocusSkillDeps): ToolDefinition {
  return {
    name: "focus_list_session",
    description: "List the current session's top focus cards.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum cards, default 5." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["focus", "session"],
      aliases: ["list session focus cards", "current session focus"],
      priority: 0.68,
    },
    async execute(input, context): Promise<ToolResult> {
      if (!context?.sessionId) {
        return fail("focus_list_session requires an active session.");
      }
      const parsed = parseListInput(input);
      if ("ok" in parsed) return parsed;
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      const cards = deps.store.getSessionShelf(clientId, context.sessionId, parsed.limit);
      return jsonResult({ sessionFocusCards: cards.map(serializeShelfItem) });
    },
  };
}

function createFocusListAttentionTool(deps: FocusSkillDeps): ToolDefinition {
  return {
    name: "focus_list_attention",
    description: "List global attention-shelf focus cards across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum cards, default 5." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["focus", "attention shelf", "global"],
      aliases: ["list attention shelf", "global focus cards"],
      priority: 0.68,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseListInput(input);
      if ("ok" in parsed) return parsed;
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      const cards = deps.store.getGlobalShelf(clientId, parsed.limit);
      return jsonResult({ attentionShelf: cards.map(serializeShelfItem) });
    },
  };
}

function createFocusListActiveTool(deps: FocusSkillDeps): ToolDefinition {
  return {
    name: "focus_list_active",
    description: "List focus cards currently activated for this session.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum cards, default 3." },
      },
    },
    selectionHints: {
      domain: "memory",
      tags: ["focus", "active"],
      aliases: ["list active focus", "active focus cards"],
      priority: 0.7,
    },
    async execute(input, context): Promise<ToolResult> {
      if (!context?.sessionId) {
        return fail("focus_list_active requires an active session.");
      }
      const parsed = parseListInput(input);
      if ("ok" in parsed) return parsed;
      const clientId = clientIdFromContext(context, deps.defaultClientId);
      const cards = deps.store.getActiveFocus(clientId, context.sessionId, parsed.limit);
      return jsonResult({ activeFocus: cards.map(serializeShelfItem) });
    },
  };
}

const FOCUS_PROMPT_BLOCK = [
  "The focus tools are built in.",
  "Focus cards track reusable work state: current session focus cards, activeFocus, and cross-session attention shelf cards.",
  "Context shelves are compact previews; use focus_get or focus_activate to load the full card with runs, assets, and currentState before continuing prior work.",
  "Use focus_search when the user says continue, resume, previous, last issue, last file, or refers to prior tool-based work.",
  "Use focus_activate after finding a relevant card so it appears in activeFocus context for the rest of the session.",
  "Use focus_update when a focus card's open work, verified facts, next step, or summary changes.",
  "Session focus cards describe tool-using runs in the current session; attention shelf cards are durable cross-session focus cards.",
].join("\n");

export function createFocusSkill(deps: FocusSkillDeps): SkillDefinition {
  return {
    id: "focus",
    version: "1.0.0",
    description: "Search, activate, and update session/global focus cards.",
    promptBlock: FOCUS_PROMPT_BLOCK,
    tools: [
      createFocusSearchTool(deps),
      createFocusGetTool(deps),
      createFocusActivateTool(deps),
      createFocusDeactivateTool(deps),
      createFocusUpdateTool(deps),
      createFocusListSessionTool(deps),
      createFocusListAttentionTool(deps),
      createFocusListActiveTool(deps),
    ],
  };
}

function parseSearchInput(input: unknown): FocusSearchInput | ToolResult {
  const value = readObject(input);
  if (!value) return fail("Invalid input: expected an object.");
  const query = readString(value, "query");
  if (!query) return fail("Invalid input: query is required.");
  const scope = readScope(value["scope"]);
  if (scope === null) return fail("Invalid input: scope must be session, global, or all.");
  return {
    query,
    ...(scope ? { scope } : {}),
    ...readLimitField(value, 5),
  };
}

function parseFocusIdInput(input: unknown): FocusIdInput | ToolResult {
  const value = readObject(input);
  if (!value) return fail("Invalid input: expected an object.");
  const focusId = readString(value, "focusId") || readString(value, "focus_id");
  if (!focusId) return fail("Invalid input: focusId is required.");
  return { focusId };
}

function parseActivateInput(input: unknown): FocusActivateInput | ToolResult {
  const parsed = parseFocusIdInput(input);
  if ("ok" in parsed) return parsed;
  const value = readObject(input) ?? {};
  const reason = readString(value, "reason");
  return {
    focusId: parsed.focusId,
    ...(reason ? { reason } : {}),
  };
}

function parseDeactivateInput(input: unknown): FocusDeactivateInput | ToolResult {
  const value = readObject(input ?? {});
  if (!value) return fail("Invalid input: expected an object.");
  const focusId = readString(value, "focusId") || readString(value, "focus_id");
  return focusId ? { focusId } : {};
}

function parseUpdateInput(input: unknown): FocusUpdateInput | ToolResult {
  const parsed = parseFocusIdInput(input);
  if ("ok" in parsed) return parsed;
  const value = readObject(input) ?? {};
  const openWork = readOptionalStringArray(value["openWork"] ?? value["open_work"], "openWork");
  if (isToolResult(openWork)) return openWork;
  const verifiedFacts = readOptionalStringArray(value["verifiedFacts"] ?? value["verified_facts"], "verifiedFacts");
  if (isToolResult(verifiedFacts)) return verifiedFacts;
  const summary = readString(value, "summary");
  const nextStep = typeof value["nextStep"] === "string"
    ? value["nextStep"]
    : (typeof value["next_step"] === "string" ? value["next_step"] : undefined);
  if (!summary && !openWork && !verifiedFacts && nextStep === undefined) {
    return fail("Invalid input: provide summary, openWork, verifiedFacts, or nextStep.");
  }
  return {
    focusId: parsed.focusId,
    ...(summary ? { summary } : {}),
    ...(openWork ? { openWork } : {}),
    ...(verifiedFacts ? { verifiedFacts } : {}),
    ...(nextStep !== undefined ? { nextStep } : {}),
  };
}

function parseListInput(input: unknown): FocusListInput | ToolResult {
  const value = readObject(input ?? {});
  if (!value) return fail("Invalid input: expected an object.");
  return readLimitField(value, 5);
}

function readLimitField(value: Record<string, unknown>, fallback: number): { limit: number } {
  const raw = value["limit"];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { limit: fallback };
  }
  return { limit: Math.max(1, Math.min(20, Math.floor(raw))) };
}

function getOwnedFocusCard(deps: FocusSkillDeps, context: ToolExecutionContext | undefined, focusId: string): FocusCard | null {
  const clientId = clientIdFromContext(context, deps.defaultClientId);
  const card = deps.store.getFocus(focusId);
  if (!card || card.clientId !== clientId) {
    return null;
  }
  return card;
}

function clientIdFromContext(context: ToolExecutionContext | undefined, fallback?: string): string {
  return context?.clientId?.trim() || fallback || "local";
}

function readObject(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function readScope(value: unknown): FocusSearchScope | undefined | null {
  if (value === undefined) return undefined;
  if (value === "session" || value === "global" || value === "all") return value;
  return null;
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

function isToolResult(value: unknown): value is ToolResult {
  return Boolean(value && typeof value === "object" && "ok" in value);
}

function serializeShelfItem(item: FocusShelfItem): Record<string, unknown> {
  return {
    focusId: item.focusId,
    scope: item.scope,
    sessionId: item.sessionId,
    parentFocusId: item.parentFocusId,
    type: item.type,
    status: item.status,
    label: item.label,
    summary: item.summary,
    hints: item.hints,
    topArtifacts: item.topArtifacts,
    openWork: item.openWork,
    nextStep: item.nextStep,
    lastTouchedAt: item.lastTouchedAt,
    lastTouchedLabel: item.lastTouchedLabel,
    attentionScore: item.attentionScore,
    activeSessionId: item.activeSessionId,
    activatedAt: item.activatedAt,
    activatedReason: item.activatedReason,
  };
}

function serializeFocusCard(card: FocusCard): Record<string, unknown> {
  return {
    focusId: card.focusId,
    clientId: card.clientId,
    scope: card.scope,
    sessionId: card.sessionId,
    parentFocusId: card.parentFocusId,
    type: card.type,
    status: card.status,
    label: card.label,
    summary: card.summary,
    shelfSummary: card.shelfSummary,
    entities: card.entities,
    artifacts: card.artifacts,
    assets: card.assets,
    runs: card.runs,
    currentState: card.currentState,
    verifiedFacts: card.verifiedFacts,
    openWork: card.openWork,
    nextStep: card.nextStep,
    sourceRunIds: card.sourceRunIds,
    importance: card.importance,
    reuseCount: card.reuseCount,
    createdAt: card.createdAt,
    lastTouchedAt: card.lastTouchedAt,
    attentionUntil: card.attentionUntil,
    activeSessionId: card.activeSessionId,
    activatedAt: card.activatedAt,
    activatedReason: card.activatedReason,
    details: card.details,
  };
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
