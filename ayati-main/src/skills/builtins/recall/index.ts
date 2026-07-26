import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import type { EpisodicMemoryEpisodeType, EpisodicMemoryStatus } from "../../../memory/episodic/index.js";
import {
  genericObjectOutputSchema,
  succeededContract,
} from "../contract-helpers.js";

interface RecallMemoryInput {
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  episodeTypes?: EpisodicMemoryEpisodeType[];
}

interface SetEpisodicEnabledInput {
  enabled?: boolean;
}

export interface RecallRetriever {
  recall(input: {
    clientId: string;
    query?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    episodeTypes?: EpisodicMemoryEpisodeType[];
  }): Promise<unknown[]>;
}

export interface EpisodicMemoryControls {
  getStatus(clientId: string): EpisodicMemoryStatus;
  setEnabled(clientId: string, enabled: boolean): EpisodicMemoryStatus;
}

export interface RecallSkillDeps {
  retriever: RecallRetriever;
  controls?: EpisodicMemoryControls;
}

function validateRecallInput(input: unknown): RecallMemoryInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected an object." };
  }

  const value = input as Partial<RecallMemoryInput>;
  if (value.query !== undefined && typeof value.query !== "string") {
    return { ok: false, error: "Invalid input: query must be a string." };
  }
  if (value.dateFrom !== undefined && typeof value.dateFrom !== "string") {
    return { ok: false, error: "Invalid input: dateFrom must be a string." };
  }
  if (value.dateTo !== undefined && typeof value.dateTo !== "string") {
    return { ok: false, error: "Invalid input: dateTo must be a string." };
  }
  if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isFinite(value.limit))) {
    return { ok: false, error: "Invalid input: limit must be a number." };
  }
  if (value.episodeTypes !== undefined) {
    if (!Array.isArray(value.episodeTypes)) {
      return { ok: false, error: "Invalid input: episodeTypes must be an array." };
    }
    for (const episodeType of value.episodeTypes) {
      if (!isEpisodeType(episodeType)) {
        return { ok: false, error: "Invalid input: episodeTypes contains an unsupported value." };
      }
    }
  }

  const query = value.query?.trim();
  const dateFrom = value.dateFrom?.trim();
  const dateTo = value.dateTo?.trim();
  if (!query && !dateFrom && !dateTo) {
    return { ok: false, error: "Invalid input: provide query and/or a date range." };
  }

  return {
    ...(query ? { query } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
    ...(Array.isArray(value.episodeTypes) && value.episodeTypes.length > 0 ? { episodeTypes: value.episodeTypes } : {}),
  };
}

function validateSetEpisodicEnabledInput(input: unknown): SetEpisodicEnabledInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected an object." };
  }
  const value = input as SetEpisodicEnabledInput;
  if (typeof value.enabled !== "boolean") {
    return { ok: false, error: "Invalid input: enabled must be a boolean." };
  }
  return { enabled: value.enabled };
}

function createRecallTool(deps: RecallSkillDeps): ToolDefinition {
  return {
    name: "recall_memory",
    description: "Search past run memory and session handoffs. Returns drill-down pointers plus related context.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for in past work. Use this for semantic recall.",
        },
        dateFrom: {
          type: "string",
          description: "Optional lower date/time bound (ISO timestamp or YYYY-MM-DD).",
        },
        dateTo: {
          type: "string",
          description: "Optional upper date/time bound (ISO timestamp or YYYY-MM-DD).",
        },
        limit: {
          type: "number",
          description: "Maximum number of matches to return (default 5, max 8).",
        },
        episodeTypes: {
          type: "array",
          description: "Optional episode type filters.",
          items: {
            type: "string",
            enum: ["conversation_exchange", "task_outcome", "session_summary"],
          },
        },
      },
    },
    outputSchema: genericObjectOutputSchema,
    resultContract: succeededContract({
      assertions: [{
        id: "episodic_matches_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.matches",
      }],
      progressFacts: [{
        kind: "memory_read_completed",
        path: "$.result.structuredContent.subject",
        message: "Episodic memory recall completed.",
      }],
    }),
    async execute(input, context): Promise<ToolResult> {
      const parsed = validateRecallInput(input);
      if ("ok" in parsed) {
        return parsed;
      }

      const matches = await deps.retriever.recall({
        clientId: context?.clientId ?? "local",
        query: parsed.query,
        dateFrom: parsed.dateFrom,
        dateTo: parsed.dateTo,
        limit: parsed.limit,
        episodeTypes: parsed.episodeTypes,
      });

      return {
        ok: true,
        output: JSON.stringify({
          subject: parsed.query?.trim() || "all",
          matches,
        }, null, 2),
      };
    },
  };
}

function createMemoryStatusTool(deps: RecallSkillDeps): ToolDefinition {
  return {
    name: "memory_status",
    description: "Show whether episodic long-term memory is enabled and whether embedding/indexing is healthy.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    outputSchema: genericObjectOutputSchema,
    resultContract: succeededContract({
      progressFacts: [{
        kind: "memory_read_completed",
        path: "$.result.structuredContent.enabled",
        message: "Episodic memory status was read.",
      }],
    }),
    async execute(_input, context): Promise<ToolResult> {
      if (!deps.controls) {
        return { ok: false, error: "Episodic memory controls are unavailable." };
      }
      const status = deps.controls.getStatus(context?.clientId ?? "local");
      return {
        ok: true,
        output: JSON.stringify(status, null, 2),
      };
    },
  };
}

function createSetEpisodicEnabledTool(deps: RecallSkillDeps): ToolDefinition {
  return {
    name: "memory_set_episodic_enabled",
    description: "Enable or disable episodic long-term memory for future session indexing.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "true enables episodic memory; false disables future episodic indexing.",
        },
      },
      required: ["enabled"],
    },
    outputSchema: genericObjectOutputSchema,
    resultContract: succeededContract({
      progressFacts: [{
        kind: "memory_change_completed",
        path: "$.result.structuredContent.enabled",
        message: "Episodic memory setting was changed.",
      }],
    }),
    async execute(input, context): Promise<ToolResult> {
      if (!deps.controls) {
        return { ok: false, error: "Episodic memory controls are unavailable." };
      }
      const parsed = validateSetEpisodicEnabledInput(input);
      if ("ok" in parsed) {
        return parsed;
      }
      const status = deps.controls.setEnabled(context?.clientId ?? "local", parsed.enabled === true);
      return {
        ok: true,
        output: JSON.stringify(status, null, 2),
      };
    },
  };
}

export function createRecallSkill(deps: RecallSkillDeps): SkillDefinition {
  return {
    id: "recall",
    version: "1.0.0",
    description: "Recall past episodic conversation memory.",
    tools: [
      createRecallTool(deps),
      createMemoryStatusTool(deps),
      createSetEpisodicEnabledTool(deps),
    ],
  };
}

function isEpisodeType(value: unknown): value is EpisodicMemoryEpisodeType {
  return value === "conversation_exchange" || value === "task_outcome" || value === "session_summary";
}
