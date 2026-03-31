import type { PreparedAttachmentService } from "../../../documents/prepared-attachment-service.js";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

export interface DatasetSkillDeps {
  preparedAttachmentService: PreparedAttachmentService;
}

const DATASET_PROMPT_BLOCK = [
  "Prepared dataset tools are built in for structured attachments.",
  "Use dataset_profile to inspect a prepared CSV or XLSX attachment before generating SQL.",
  "Use dataset_query for SQL over staged prepared datasets.",
  "Use dataset_promote_table only when the user explicitly wants the data saved into a durable SQLite table.",
  "Inputs accept a prepared attachment reference: preparedInputId is preferred, but the exact display name also works.",
  "If exactly one structured attachment exists in the run, the dataset tools can auto-select it.",
].join("\n");

function buildSuccessResult(output: Record<string, unknown>, meta?: Record<string, unknown>): ToolResult {
  return {
    ok: true,
    output: JSON.stringify(output, null, 2),
    ...(meta ? { meta } : {}),
  };
}

function buildFailureResult(error: string): ToolResult {
  return {
    ok: false,
    error,
  };
}

function createDatasetProfileTool(deps: DatasetSkillDeps): ToolDefinition {
  return {
    name: "dataset_profile",
    description: "Inspect a prepared structured attachment and return schema, samples, and staging metadata.",
    inputSchema: {
      type: "object",
      properties: {
        preparedInputId: { type: "string", description: "Prepared structured attachment reference. Use the preparedInputId when known; the display name also works." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["dataset", "csv", "xlsx", "spreadsheet", "profile", "schema"],
      domain: "data",
      priority: 70,
    },
    async execute(input, context): Promise<ToolResult> {
      const preparedInputId = readOptionalString(input, "preparedInputId");
      const runId = readRunId(context);
      try {
        return buildSuccessResult(await deps.preparedAttachmentService.profileDataset(runId, preparedInputId));
      } catch (err) {
        return buildFailureResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createDatasetQueryTool(deps: DatasetSkillDeps): ToolDefinition {
  return {
    name: "dataset_query",
    description: "Run SQL against a prepared structured attachment using a run-scoped staging database.",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: {
        preparedInputId: { type: "string", description: "Prepared structured attachment reference. Use the preparedInputId when known; the display name also works." },
        sql: { type: "string", description: "Single SELECT query to run against the staged dataset." },
        maxRows: { type: "number", description: "Optional row cap for returned results." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["dataset", "csv", "xlsx", "spreadsheet", "sql", "query"],
      domain: "data",
      priority: 90,
    },
    async execute(input, context): Promise<ToolResult> {
      const preparedInputId = readOptionalString(input, "preparedInputId");
      const sql = readRequiredString(input, "sql");
      const maxRows = readOptionalNumber(input, "maxRows");
      const runId = readRunId(context);
      try {
        const output = await deps.preparedAttachmentService.queryDataset({ runId, preparedInputId, sql, maxRows });
        const stateUpdates = buildDatasetStateUpdates(output);
        return buildSuccessResult(output, stateUpdates.length > 0 ? { stateUpdates } : undefined);
      } catch (err) {
        return buildFailureResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createDatasetPromoteTableTool(deps: DatasetSkillDeps): ToolDefinition {
  return {
    name: "dataset_promote_table",
    description: "Save a prepared structured attachment into a durable SQLite target table.",
    inputSchema: {
      type: "object",
      required: ["targetTable"],
      properties: {
        preparedInputId: { type: "string", description: "Prepared structured attachment reference. Use the preparedInputId when known; the display name also works." },
        targetTable: { type: "string", description: "Destination SQLite table name." },
        targetDbPath: { type: "string", description: "Optional target SQLite database path." },
        ifExists: { type: "string", enum: ["fail", "replace", "append"] },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["dataset", "csv", "xlsx", "spreadsheet", "save", "database", "import"],
      domain: "data",
      priority: 85,
    },
    async execute(input, context): Promise<ToolResult> {
      const preparedInputId = readOptionalString(input, "preparedInputId");
      const targetTable = readRequiredString(input, "targetTable");
      const targetDbPath = readOptionalString(input, "targetDbPath");
      const ifExists = readOptionalEnum(input, "ifExists", ["fail", "replace", "append"] as const);
      const runId = readRunId(context);
      try {
        return buildSuccessResult(await deps.preparedAttachmentService.promoteDataset({
          runId,
          preparedInputId,
          targetTable,
          ...(targetDbPath ? { targetDbPath } : {}),
          ...(ifExists ? { ifExists } : {}),
        }));
      } catch (err) {
        return buildFailureResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createDatasetSkill(deps: DatasetSkillDeps): SkillDefinition {
  return {
    id: "datasets",
    version: "1.0.0",
    description: "Prepared structured attachment tools for schema inspection, SQL querying, and durable import.",
    promptBlock: DATASET_PROMPT_BLOCK,
    tools: [
      createDatasetProfileTool(deps),
      createDatasetQueryTool(deps),
      createDatasetPromoteTableTool(deps),
    ],
  };
}

function readRunId(context: { runId?: string } | undefined): string {
  if (!context?.runId || context.runId.trim().length === 0) {
    throw new Error("dataset tools require a runId in tool execution context.");
  }
  return context.runId;
}

function readRequiredString(input: unknown, field: string): string {
  const record = isPlainObject(input) ? input : {};
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalString(input: unknown, field: string): string | undefined {
  const record = isPlainObject(input) ? input : {};
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalNumber(input: unknown, field: string): number | undefined {
  const record = isPlainObject(input) ? input : {};
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalEnum<T extends readonly string[]>(input: unknown, field: string, allowed: T): T[number] | undefined {
  const value = readOptionalString(input, field);
  return value && allowed.includes(value as T[number]) ? value as T[number] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildDatasetStateUpdates(output: Record<string, unknown>): Array<Record<string, unknown>> {
  const preparedInputId = typeof output["preparedInputId"] === "string" ? output["preparedInputId"] : "";
  if (!preparedInputId || output["staged"] !== true) {
    return [];
  }
  return [{
    type: "mark_dataset_staged",
    preparedInputId,
    staged: true,
    ...(typeof output["dbPath"] === "string" ? { stagingDbPath: output["dbPath"] } : {}),
    ...(typeof output["tableName"] === "string" ? { stagingTableName: output["tableName"] } : {}),
  }];
}
