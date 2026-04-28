import { scoreMemory } from "../../../memory/personal/memory-scorer.js";
import { MemoryResolver } from "../../../memory/personal/memory-resolver.js";
import { normalizeKind, normalizeSlot, type PersonalMemoryStore } from "../../../memory/personal/personal-memory-store.js";
import { DEFAULT_MEMORY_POLICY } from "../../../memory/personal/memory-policy.js";
import type { MemoryCard, MemoryProposal } from "../../../memory/personal/types.js";
import {
  EVOLVING_MEMORY_SECTION_ID,
  TIME_BASED_SECTION_ID,
  USER_FACTS_SECTION_ID,
  type MemorySectionId,
} from "../../../memory/personal/types.js";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

export interface MemorySkillDeps {
  store: PersonalMemoryStore;
  defaultUserId?: string;
}

function validateObject(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" ? input as Record<string, unknown> : null;
}

function userIdFromContext(contextUserId: string | undefined, fallback?: string): string {
  return contextUserId?.trim() || fallback || "local";
}

function createSearchTool(deps: MemorySkillDeps): ToolDefinition {
  return {
    name: "memory_search",
    description: "Search canonical User Facts memory cards, not episodic conversation recall.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword query for fact text, kind, slot, or value." },
        sectionId: { type: "string", description: "Optional section: user_facts, time_based, or evolving_memory." },
        type: { type: "string", description: "Optional memory type, such as identity, preference, or goal." },
        kind: { type: "string", description: "Alias for type." },
        slot: { type: "string", description: "Optional exact fact slot, such as identity/name." },
        limit: { type: "number", description: "Maximum matches, default 10." },
      },
    },
    async execute(input, context): Promise<ToolResult> {
      const value = validateObject(input) ?? {};
      const userId = userIdFromContext(context?.clientId, deps.defaultUserId);
      const matches = deps.store.searchMemories(userId, {
        query: typeof value["query"] === "string" ? value["query"] : undefined,
        sectionId: normalizeSectionInput(value["sectionId"] ?? value["section_id"]),
        kind: typeof value["kind"] === "string"
          ? value["kind"]
          : (typeof value["type"] === "string" ? value["type"] : undefined),
        slot: typeof value["slot"] === "string" ? value["slot"] : undefined,
        limit: typeof value["limit"] === "number" ? value["limit"] : undefined,
      }).map((memory) => ({
        ...serializeMemory(memory),
        score: scoreMemory(memory),
      }));
      return { ok: true, output: JSON.stringify({ matches }, null, 2) };
    },
  };
}

function createRememberTool(deps: MemorySkillDeps): ToolDefinition {
  return {
    name: "memory_remember",
    description: "Save an explicitly user-approved User Facts memory card.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "The memory text to save." },
        content: { type: "string", description: "Alias for text." },
        type: { type: "string", description: "Optional memory type, such as identity, preference, or goal." },
        kind: { type: "string", description: "Alias for type." },
        slot: { type: "string", description: "Optional duplicate address, such as identity/name." },
        value: { type: "string", description: "Optional specific fact value." },
        sectionId: { type: "string", description: "Optional section: user_facts, time_based, or evolving_memory." },
        startsAt: { type: "string", description: "Optional ISO start time for time-based memory." },
        eventAt: { type: "string", description: "Optional ISO event time for time-based memory." },
        expiresAt: { type: "string", description: "Required ISO expiry time for time-based memory." },
        importance: { type: "number", description: "Optional importance from 0 to 1." },
      },
    },
    async execute(input, context): Promise<ToolResult> {
      const value = validateObject(input);
      const text = typeof value?.["text"] === "string"
        ? value["text"]
        : (typeof value?.["content"] === "string" ? value["content"] : "");
      if (!value || text.length === 0) {
        return { ok: false, error: "Invalid input: text or content is required." };
      }
      const inferred = inferFactAddress(text);
      const sectionId = normalizeSectionInput(value["sectionId"] ?? value["section_id"])
        ?? (typeof value["expiresAt"] === "string" ? TIME_BASED_SECTION_ID : USER_FACTS_SECTION_ID);
      const kind = typeof value["kind"] === "string"
        ? value["kind"]
        : (typeof value["type"] === "string" ? value["type"] : inferred.kind);
      const slot = typeof value["slot"] === "string" ? value["slot"] : inferred.slot;
      const proposal: MemoryProposal = {
        text,
        sectionId,
        lifecycle: lifecycleForSection(sectionId),
        kind,
        slot,
        value: typeof value["value"] === "string" ? value["value"] : inferred.value,
        startsAt: typeof value["startsAt"] === "string" ? value["startsAt"] : null,
        eventAt: typeof value["eventAt"] === "string" ? value["eventAt"] : null,
        expiresAt: typeof value["expiresAt"] === "string" ? value["expiresAt"] : null,
        confidence: 0.95,
        importance: typeof value["importance"] === "number" ? value["importance"] : inferred.importance,
        sourceType: "manual_user_request",
        sourceReliability: 0.98,
        evidence: `User explicitly asked to remember: ${text}`,
      };
      const userId = userIdFromContext(context?.clientId, deps.defaultUserId);
      const resolver = new MemoryResolver(deps.store);
      const result = resolver.resolve(userId, {
        userId,
        sessionId: context?.sessionId ?? "manual",
        sessionPath: "",
        reason: "manual_memory_remember",
        turns: [],
      }, [proposal], DEFAULT_MEMORY_POLICY);
      return { ok: true, output: JSON.stringify({ result }, null, 2) };
    },
  };
}

function createForgetTool(deps: MemorySkillDeps): ToolDefinition {
  return {
    name: "memory_forget",
    description: "Archive a User Facts memory card by id or by exact slot.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "Memory id to archive." },
        slot: { type: "string", description: "Exact slot whose live facts should be archived." },
        sectionId: { type: "string", description: "Optional section: user_facts, time_based, or evolving_memory." },
      },
    },
    async execute(input, context): Promise<ToolResult> {
      const value = validateObject(input);
      if (!value) {
        return { ok: false, error: "Invalid input: expected object." };
      }
      const userId = userIdFromContext(context?.clientId, deps.defaultUserId);
      const memoryId = typeof value["memoryId"] === "string" ? value["memoryId"].trim() : "";
      const slot = typeof value["slot"] === "string" ? normalizeSlot(value["slot"]) : "";
      const sectionId = normalizeSectionInput(value["sectionId"] ?? value["section_id"]) ?? USER_FACTS_SECTION_ID;
      const archived: string[] = [];
      if (memoryId) {
        deps.store.updateMemoryState(memoryId, "archived");
        archived.push(memoryId);
      } else if (slot) {
        for (const memory of deps.store.findMemoriesBySlot(userId, slot, ["candidate", "active"], sectionId)) {
          deps.store.updateMemoryState(memory.id, "archived");
          archived.push(memory.id);
        }
      } else {
        return { ok: false, error: "Invalid input: provide memoryId or slot." };
      }
      return { ok: true, output: JSON.stringify({ archived }, null, 2) };
    },
  };
}

function createExplainTool(deps: MemorySkillDeps): ToolDefinition {
  return {
    name: "memory_explain",
    description: "Explain why a User Facts memory exists, including evidence and confidence.",
    inputSchema: {
      type: "object",
      required: ["memoryId"],
      properties: {
        memoryId: { type: "string", description: "Memory id to explain." },
      },
    },
    async execute(input): Promise<ToolResult> {
      const value = validateObject(input);
      const memoryId = typeof value?.["memoryId"] === "string" ? value["memoryId"].trim() : "";
      if (!memoryId) {
        return { ok: false, error: "Invalid input: memoryId is required." };
      }
      const memory = deps.store.getMemory(memoryId);
      if (!memory) {
        return { ok: false, error: `Unknown memory id: ${memoryId}` };
      }
      const evidence = deps.store.listEvidence(memoryId, 12);
      return {
        ok: true,
        output: JSON.stringify({ memory: serializeMemory(memory), score: scoreMemory(memory), evidence }, null, 2),
      };
    },
  };
}

function createFeedbackTool(deps: MemorySkillDeps): ToolDefinition {
  return {
    name: "memory_feedback",
    description: "Mark a User Facts memory as helpful or harmful after it was used.",
    inputSchema: {
      type: "object",
      required: ["memoryId", "outcome"],
      properties: {
        memoryId: { type: "string", description: "Memory id." },
        outcome: { type: "string", description: "helpful or harmful." },
      },
    },
    async execute(input, context): Promise<ToolResult> {
      const value = validateObject(input);
      const memoryId = typeof value?.["memoryId"] === "string" ? value["memoryId"].trim() : "";
      const outcome = value?.["outcome"] === "harmful" || value?.["outcome"] === "failure" ? "harmful" : "helpful";
      if (!memoryId) {
        return { ok: false, error: "Invalid input: memoryId is required." };
      }
      deps.store.recordUsage(memoryId, context?.runId ?? null, outcome);
      return { ok: true, output: JSON.stringify({ memoryId, outcome }, null, 2) };
    },
  };
}

const MEMORY_PROMPT_BLOCK = [
  "The personal memory tools are built in.",
  "Personal memory currently stores User Facts, Time-Based, and Evolving Memory cards.",
  "Use memory_search for canonical personal memory cards. Use recall_memory for prior conversations and episodic history.",
  "Use memory_remember only when the user explicitly asks to save or remember a stable fact, timed memory, or evolving personalization memory.",
  "Time-Based memories must include expiresAt.",
  "Use sectionId=evolving_memory for preferences, goals, skills, environment, constraints, procedures, feedback, routines, decisions, relationships, and permissions.",
  "Use memory_forget when the user asks to forget, remove, or correct a stored memory.",
  "Use memory_explain when the user asks why Ayati believes a memory.",
].join("\n");

export function createMemorySkill(deps: MemorySkillDeps): SkillDefinition {
  return {
    id: "memory",
    version: "1.0.0",
    description: "Search and manage canonical User Facts memories.",
    promptBlock: MEMORY_PROMPT_BLOCK,
    tools: [
      createSearchTool(deps),
      createRememberTool(deps),
      createForgetTool(deps),
      createExplainTool(deps),
      createFeedbackTool(deps),
    ],
  };
}

function inferFactAddress(text: string): { kind: string; slot: string; value?: string; importance: number } {
  const normalized = text.toLowerCase();
  const value = extractIsValue(text);
  if (/\b(name|called)\b/.test(normalized) && /\b(user|my|me|i am|i'm)\b/.test(normalized)) {
    return { kind: "identity", slot: "identity/name", value, importance: 1 };
  }
  if (/\b(date of birth|dob|birthday|born)\b/.test(normalized)) {
    return { kind: "identity", slot: "identity/date_of_birth", value, importance: 1 };
  }
  if (/\bmother tongue|native language|first language\b/.test(normalized)) {
    return { kind: "identity", slot: "identity/mother_tongue", value, importance: 0.9 };
  }
  if (/\bmother\b/.test(normalized) && /\bname\b/.test(normalized)) {
    return { kind: "family", slot: "family/mother_name", value, importance: 0.85 };
  }
  if (/\bfather\b/.test(normalized) && /\bname\b/.test(normalized)) {
    return { kind: "family", slot: "family/father_name", value, importance: 0.85 };
  }
  if (/\bfriend\b/.test(normalized)) {
    return { kind: "relationship", slot: "relationships/friends", value, importance: 0.65 };
  }
  const firstWords = text.split(/\s+/).slice(0, 3).join("_");
  return {
    kind: "general",
    slot: `general/${normalizeKind(firstWords) || "fact"}`,
    value,
    importance: 0.7,
  };
}

function normalizeSectionInput(value: unknown): MemorySectionId | undefined {
  if (value === TIME_BASED_SECTION_ID) {
    return TIME_BASED_SECTION_ID;
  }
  if (value === EVOLVING_MEMORY_SECTION_ID) {
    return EVOLVING_MEMORY_SECTION_ID;
  }
  if (value === USER_FACTS_SECTION_ID) {
    return USER_FACTS_SECTION_ID;
  }
  return undefined;
}

function lifecycleForSection(sectionId: MemorySectionId): MemoryProposal["lifecycle"] {
  if (sectionId === TIME_BASED_SECTION_ID) return "timed";
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) return "evolving";
  return "fact";
}

function serializeMemory(memory: MemoryCard) {
  return {
    ...memory,
    type: memory.kind,
    content: memory.text,
  };
}

function extractIsValue(text: string): string | undefined {
  const match = text.match(/\bis\s+(.+?)[.!]?$/i) ?? text.match(/\b(?:am|called)\s+(.+?)[.!]?$/i);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}
