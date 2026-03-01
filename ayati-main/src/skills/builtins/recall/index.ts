import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import type { MemoryRetriever } from "../../../memory/retrieval/memory-retriever.js";

interface RecallMemoryInput {
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface RecallSkillDeps {
  retriever: MemoryRetriever;
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
  };
}

function createRecallTool(deps: RecallSkillDeps): ToolDefinition {
  return {
    name: "recall_memory",
    description: "Search past task summaries and session handoff notes. Returns compact matches with session metadata only.",
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
      },
    },
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
      });

      return {
        ok: true,
        output: JSON.stringify({ matches }, null, 2),
      };
    },
  };
}

const RECALL_PROMPT_BLOCK = [
  "Recall Skill is available.",
  "Use recall_memory when the user refers to prior work, earlier conversations, 'like before', or asks what happened on a past date/time.",
  "recall_memory returns compact summary matches with sessionPath metadata only.",
  "If you need exact details after recall_memory, use the existing read_file tool on the returned sessionPath to inspect that session file.",
  "Prefer recall_memory before guessing how prior work was done.",
].join("\n");

export function createRecallSkill(deps: RecallSkillDeps): SkillDefinition {
  return {
    id: "recall",
    version: "1.0.0",
    description: "Recall past task summaries and handoff notes.",
    promptBlock: RECALL_PROMPT_BLOCK,
    tools: [createRecallTool(deps)],
  };
}
