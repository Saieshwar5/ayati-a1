import type { ArtifactRef, SkillDefinition, ToolContractAssertion, ToolDefinition, ToolResult } from "../../types.js";
import { commonAnnotations, errorResult, genericObjectOutputSchema, okJsonResult, succeededContract } from "../contract-helpers.js";
import {
  addColumns,
  createTable,
  deleteRows,
  describeTable,
  dropTable,
  getTableDdl,
  insertRows,
  listTables,
  queryTable,
  renameTable,
  updateRows,
} from "../../../database/sqlite-runtime.js";
import type { DatabaseColumnInput } from "../../../database/sqlite-runtime.js";
import { requireAbsolutePath } from "../../workspace-paths.js";

const GENERIC_JSON_VALUE_SCHEMA: Record<string, unknown> = {};
const STRING_ARRAY_ITEM_SCHEMA: Record<string, unknown> = {
  type: "string",
};
const DATABASE_COLUMN_REFERENCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["table", "column"],
  properties: {
    table: { type: "string", description: "Referenced table name." },
    column: { type: "string", description: "Referenced column name." },
  },
};
const DATABASE_COLUMN_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", description: "Column name." },
    type: { type: "string", description: "SQLite column type such as TEXT or INTEGER." },
    notNull: { type: "boolean", description: "Mark the column as NOT NULL." },
    primaryKey: { type: "boolean", description: "Mark the column as part of the primary key." },
    unique: { type: "boolean", description: "Require unique values in the column." },
    defaultValue: { description: "Literal default value for the column." },
    defaultSql: { type: "string", description: "Raw SQL DEFAULT expression." },
    references: DATABASE_COLUMN_REFERENCE_SCHEMA,
    check: { type: "string", description: "CHECK constraint SQL for the column." },
  },
};
const DATABASE_ROW_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
};

function buildSuccessResult(output: unknown, meta?: Record<string, unknown>): ToolResult {
  const artifacts = databaseArtifacts(output, meta);
  return okJsonResult({
    structuredContent: output,
    code: "DATABASE_OPERATION_SUCCEEDED",
    message: "Database operation succeeded.",
    ...(meta ? { meta } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  });
}

function buildFailureResult(error: string): ToolResult {
  const isValidation = error.startsWith("Invalid input:");
  return errorResult({
    code: isValidation ? "DATABASE_INPUT_INVALID" : "DATABASE_OPERATION_FAILED",
    message: error,
    category: isValidation ? "validation" : undefined,
    retryable: isValidation,
    recoverable: true,
    suggestedNextActions: isValidation
      ? ["Fix the database tool arguments and retry."]
      : ["Inspect the database error, schema, and SQL, then retry with corrected input."],
  });
}

function databaseArtifacts(output: unknown, meta?: Record<string, unknown>): ArtifactRef[] {
  const artifacts: ArtifactRef[] = [];
  const dbPath = isPlainObject(output) && typeof output["dbPath"] === "string"
    ? output["dbPath"]
    : typeof meta?.["dbPath"] === "string"
      ? meta["dbPath"]
      : undefined;
  const table = isPlainObject(output) && typeof output["table"] === "string"
    ? output["table"]
    : typeof meta?.["table"] === "string"
      ? meta["table"]
      : undefined;
  const newName = isPlainObject(output) && typeof output["newName"] === "string"
    ? output["newName"]
    : typeof meta?.["newName"] === "string"
      ? meta["newName"]
      : undefined;

  if (table) {
    artifacts.push({ kind: "table", id: table, metadata: { dbPath } });
  }
  if (newName && newName !== table) {
    artifacts.push({ kind: "table", id: newName, metadata: { dbPath } });
  }
  return artifacts;
}

type DatabaseContractMode = "read" | "write" | "destructive";

function withDatabaseContract(tool: ToolDefinition, mode: DatabaseContractMode): ToolDefinition {
  const readOnly = mode === "read";
  return {
    ...tool,
    outputSchema: genericObjectOutputSchema,
    annotations: commonAnnotations({
      domain: "database",
      readOnly,
      mutatesWorkspace: !readOnly,
      destructive: mode === "destructive",
      idempotent: readOnly,
      retrySafe: readOnly,
    }),
    resultContract: succeededContract({
      assertions: databaseContractAssertions(tool.name),
      artifacts: [
        { kind: "table", path: "$.result.structuredContent.table" },
        { kind: "table", path: "$.result.structuredContent.newName" },
      ],
      progressFacts: [{
        kind: readOnly ? "database_read" : "database_mutated",
        path: databaseProgressSubjectPath(tool.name),
        message: readOnly ? "Database state read by database tool." : "Database state mutated by database tool.",
      }],
    }),
  };
}

function databaseProgressSubjectPath(toolName: string): string {
  if (toolName === "db_list_tables") {
    return "$.result.structuredContent.dbPath";
  }
  if (toolName === "db_rename_table") {
    return "$.result.structuredContent.newName";
  }
  return "$.result.structuredContent.table";
}

function databaseContractAssertions(toolName: string): ToolContractAssertion[] {
  const outputPresent: ToolContractAssertion = {
    id: "database_output_present",
    kind: "json_path_exists",
    path: "$.result.structuredContent",
  };
  const tableExists = (id = "database_table_exists", tablePath = "$.result.structuredContent.table"): ToolContractAssertion => ({
    id,
    kind: "sqlite_table_exists",
    tablePath,
    dbPathPath: "$.input.dbPath",
  });
  const tableNotExists = (id = "database_table_absent", tablePath = "$.result.structuredContent.table"): ToolContractAssertion => ({
    id,
    kind: "sqlite_table_not_exists",
    tablePath,
    dbPathPath: "$.input.dbPath",
  });

  switch (toolName) {
    case "db_create_table":
    case "db_describe_table":
    case "db_get_table_ddl":
    case "db_add_columns":
    case "db_update_rows":
    case "db_delete_rows":
      return [outputPresent, tableExists()];
    case "db_insert_rows":
      return [
        outputPresent,
        tableExists(),
        {
          id: "inserted_count_matches_input",
          kind: "json_path_number_equals_count",
          path: "$.result.structuredContent.insertedRowCount",
          equalsPath: "$.input.rows",
        },
      ];
    case "db_query":
      return [outputPresent, tableExists("queried_table_exists", "$.input.table")];
    case "db_rename_table":
      return [
        outputPresent,
        tableNotExists("old_table_absent", "$.result.structuredContent.table"),
        tableExists("new_table_exists", "$.result.structuredContent.newName"),
      ];
    case "db_drop_table":
      return [outputPresent, tableNotExists()];
    default:
      return [outputPresent];
  }
}

function createListTablesTool(): ToolDefinition {
  return {
    name: "db_list_tables",
    description: "List user tables in a SQLite database with row counts and create SQL.",
    inputSchema: {
      type: "object",
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
      },
    },
    async execute(input): Promise<ToolResult> {
      const payload = isPlainObject(input) ? input : {};
      const dbPath = readOptionalDatabasePath(payload);
      if (isToolResult(dbPath)) return dbPath;
      const result = listTables(dbPath);
      return result.ok
        ? buildSuccessResult(result.data, { dbPath: result.data?.dbPath })
        : buildFailureResult(result.error ?? "Failed to list tables.");
    },
  };
}

function createDescribeTableTool(): ToolDefinition {
  return {
    name: "db_describe_table",
    description: "Describe a SQLite table: columns, indexes, foreign keys, row count, and sample rows.",
    inputSchema: {
      type: "object",
      required: ["table"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Table name to describe." },
        sampleLimit: { type: "number", description: "Optional sample row limit (default 50, max 200)." },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const sampleLimit = readOptionalNumber(input, "sampleLimit");
      if (isToolResult(sampleLimit)) return sampleLimit;
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;
      const result = describeTable({
        dbPath,
        table,
        ...(typeof sampleLimit === "number" ? { sampleLimit } : {}),
      });
      return result.ok
        ? buildSuccessResult(result.data, { table })
        : buildFailureResult(result.error ?? "Failed to describe table.");
    },
  };
}

function createGetTableDdlTool(): ToolDefinition {
  return {
    name: "db_get_table_ddl",
    description: "Return the CREATE TABLE SQL for an existing SQLite table.",
    inputSchema: {
      type: "object",
      required: ["table"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Table name." },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;
      const result = getTableDdl({ dbPath, table });
      return result.ok
        ? buildSuccessResult(result.data, { table })
        : buildFailureResult(result.error ?? "Failed to get table DDL.");
    },
  };
}

function createCreateTableTool(): ToolDefinition {
  return {
    name: "db_create_table",
    description: "Create a new SQLite table from structured column definitions.",
    inputSchema: {
      type: "object",
      required: ["table", "columns"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Table name to create." },
        ifNotExists: { type: "boolean", description: "Create only when missing. Defaults to true." },
        columns: {
          type: "array",
          description: "Column definitions for the new table.",
          items: DATABASE_COLUMN_SCHEMA,
        },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;
      const ifNotExists = readOptionalBoolean(input, "ifNotExists");
      if (isToolResult(ifNotExists)) return ifNotExists;
      const columns = readRequiredArray(input, "columns");
      if (isToolResult(columns)) return columns;
      const result = createTable({
        dbPath,
        table,
        columns: columns as DatabaseColumnInput[],
        ...(typeof ifNotExists === "boolean" ? { ifNotExists } : {}),
      });
      return result.ok
        ? buildSuccessResult(result.data, { table })
        : buildFailureResult(result.error ?? "Failed to create table.");
    },
  };
}

function createRenameTableTool(): ToolDefinition {
  return {
    name: "db_rename_table",
    description: "Rename an existing SQLite table.",
    inputSchema: {
      type: "object",
      required: ["table", "newName"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Current table name." },
        newName: { type: "string", description: "New table name." },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const newName = readRequiredString(input, "newName");
      if (isToolResult(newName)) return newName;
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;
      const result = renameTable({ dbPath, table, newName });
      return result.ok
        ? buildSuccessResult(result.data, { table, newName })
        : buildFailureResult(result.error ?? "Failed to rename table.");
    },
  };
}

function createDropTableTool(): ToolDefinition {
  return {
    name: "db_drop_table",
    description: "Drop a SQLite table.",
    inputSchema: {
      type: "object",
      required: ["table"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Table name to drop." },
        ifExists: { type: "boolean", description: "Ignore missing tables when true." },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const ifExists = readOptionalBoolean(input, "ifExists");
      if (isToolResult(ifExists)) return ifExists;
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;
      const result = dropTable({
        dbPath,
        table,
        ...(typeof ifExists === "boolean" ? { ifExists } : {}),
      });
      return result.ok
        ? buildSuccessResult(result.data, { table })
        : buildFailureResult(result.error ?? "Failed to drop table.");
    },
  };
}

function createAddColumnsTool(): ToolDefinition {
  return {
    name: "db_add_columns",
    description: "Add one or more columns to an existing SQLite table.",
    inputSchema: {
      type: "object",
      required: ["table", "columns"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Table name." },
        columns: {
          type: "array",
          description: "Column definitions to add.",
          items: DATABASE_COLUMN_SCHEMA,
        },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const columns = readRequiredArray(input, "columns");
      if (isToolResult(columns)) return columns;
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;
      const result = addColumns({ dbPath, table, columns: columns as DatabaseColumnInput[] });
      return result.ok
        ? buildSuccessResult(result.data, { table })
        : buildFailureResult(result.error ?? "Failed to add columns.");
    },
  };
}

function createInsertRowsTool(): ToolDefinition {
  return {
    name: "db_insert_rows",
    description: "Insert one or more JSON-like row objects into a SQLite table.",
    inputSchema: {
      type: "object",
      required: ["table", "rows"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Table name." },
        rows: {
          type: "array",
          description: "Rows to insert as objects keyed by column name.",
          items: DATABASE_ROW_OBJECT_SCHEMA,
        },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const rows = readRequiredArray(input, "rows");
      if (isToolResult(rows)) return rows;
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;
      const result = insertRows({ dbPath, table, rows: rows as Array<Record<string, unknown>> });
      return result.ok
        ? buildSuccessResult(result.data, { table })
        : buildFailureResult(result.error ?? "Failed to insert rows.");
    },
  };
}

function createUpdateRowsTool(): ToolDefinition {
  return {
    name: "db_update_rows",
    description: "Update rows in a SQLite table using a patch object and optional WHERE SQL.",
    inputSchema: {
      type: "object",
      required: ["table", "set"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Table name." },
        set: { type: "object", description: "Patch object keyed by column name." },
        whereSql: { type: "string", description: "Optional SQL after WHERE, such as id = ?." },
        params: {
          type: "array",
          description: "Optional positional parameters for whereSql.",
          items: GENERIC_JSON_VALUE_SCHEMA,
        },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const set = readRequiredObject(input, "set");
      if (isToolResult(set)) return set;
      const whereSql = readOptionalString(input, "whereSql");
      const params = readOptionalArray(input, "params");
      if (isToolResult(params)) return params;
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;
      const result = updateRows({
        dbPath,
        table,
        set,
        ...(typeof whereSql === "string" ? { whereSql } : {}),
        ...(Array.isArray(params) ? { params } : {}),
      });
      return result.ok
        ? buildSuccessResult(result.data, { table })
        : buildFailureResult(result.error ?? "Failed to update rows.");
    },
  };
}

function createDeleteRowsTool(): ToolDefinition {
  return {
    name: "db_delete_rows",
    description: "Delete rows from a SQLite table using optional WHERE SQL.",
    inputSchema: {
      type: "object",
      required: ["table"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Table name." },
        whereSql: { type: "string", description: "Optional SQL after WHERE, such as created_at < ?." },
        params: {
          type: "array",
          description: "Optional positional parameters for whereSql.",
          items: GENERIC_JSON_VALUE_SCHEMA,
        },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const whereSql = readOptionalString(input, "whereSql");
      const params = readOptionalArray(input, "params");
      if (isToolResult(params)) return params;
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;
      const result = deleteRows({
        dbPath,
        table,
        ...(typeof whereSql === "string" ? { whereSql } : {}),
        ...(Array.isArray(params) ? { params } : {}),
      });
      return result.ok
        ? buildSuccessResult(result.data, { table })
        : buildFailureResult(result.error ?? "Failed to delete rows.");
    },
  };
}

function createQueryTool(): ToolDefinition {
  return {
    name: "db_query",
    description: "Query rows from a SQLite table with optional columns, WHERE SQL, ORDER BY, limit, and offset.",
    inputSchema: {
      type: "object",
      required: ["table"],
      properties: {
        dbPath: { type: "string", description: "Optional canonical absolute SQLite database path. Omit to use the managed default database." },
        table: { type: "string", description: "Table name." },
        columns: {
          type: "array",
          description: "Optional list of columns to select.",
          items: STRING_ARRAY_ITEM_SCHEMA,
        },
        whereSql: { type: "string", description: "Optional SQL after WHERE." },
        params: {
          type: "array",
          description: "Optional positional parameters for whereSql.",
          items: GENERIC_JSON_VALUE_SCHEMA,
        },
        orderBy: {
          type: "array",
          description: "Optional ORDER BY expressions.",
          items: STRING_ARRAY_ITEM_SCHEMA,
        },
        limit: { type: "number", description: "Optional row limit (default 50, max 200)." },
        offset: { type: "number", description: "Optional row offset." },
      },
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const columns = readOptionalArray(input, "columns");
      if (isToolResult(columns)) return columns;
      const params = readOptionalArray(input, "params");
      if (isToolResult(params)) return params;
      const orderBy = readOptionalArray(input, "orderBy");
      if (isToolResult(orderBy)) return orderBy;
      const limit = readOptionalNumber(input, "limit");
      if (isToolResult(limit)) return limit;
      const offset = readOptionalNumber(input, "offset");
      if (isToolResult(offset)) return offset;
      const whereSql = readOptionalString(input, "whereSql");
      const dbPath = readOptionalDatabasePath(input);
      if (isToolResult(dbPath)) return dbPath;

      const result = queryTable({
        dbPath,
        table,
        ...(Array.isArray(columns) ? { columns: columns.map(String) } : {}),
        ...(typeof whereSql === "string" ? { whereSql } : {}),
        ...(Array.isArray(params) ? { params } : {}),
        ...(Array.isArray(orderBy) ? { orderBy: orderBy.map(String) } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        ...(typeof offset === "number" ? { offset } : {}),
      });
      return result.ok
        ? buildSuccessResult(result.data, { table, statementType: result.data?.statementType })
        : buildFailureResult(result.error ?? "Failed to query rows.");
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResult(value: unknown): value is ToolResult {
  return isPlainObject(value) && typeof value.ok === "boolean";
}

function readRequiredString(input: Record<string, unknown>, field: string): string | ToolResult {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return buildFailureResult(`Invalid input: ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
}

function readOptionalDatabasePath(input: Record<string, unknown>): string | ToolResult | undefined {
  const value = input["dbPath"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    return buildFailureResult("Invalid input: dbPath must be a non-empty absolute filesystem path when provided.");
  }
  const result = requireAbsolutePath(value, "dbPath");
  if (result.ok) return result.absolutePath;
  return errorResult({
    code: result.code,
    message: result.message,
    category: "validation",
    target: result.requestedPath,
    retryable: true,
    recoverable: true,
    suggestedNextActions: ["Use the absolute locator of the bound database or filesystem resource and retry."],
  });
}

function readOptionalBoolean(input: Record<string, unknown>, field: string): boolean | ToolResult | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    return buildFailureResult(`Invalid input: ${field} must be a boolean.`);
  }
  return value;
}

function readOptionalNumber(input: Record<string, unknown>, field: string): number | ToolResult | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return buildFailureResult(`Invalid input: ${field} must be a finite number.`);
  }
  return value;
}

function readRequiredArray(input: Record<string, unknown>, field: string): unknown[] | ToolResult {
  const value = input[field];
  if (!Array.isArray(value) || value.length === 0) {
    return buildFailureResult(`Invalid input: ${field} must be a non-empty array.`);
  }
  return value;
}

function readOptionalArray(input: Record<string, unknown>, field: string): unknown[] | ToolResult | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return buildFailureResult(`Invalid input: ${field} must be an array.`);
  }
  return value;
}

function readRequiredObject(input: Record<string, unknown>, field: string): Record<string, unknown> | ToolResult {
  const value = input[field];
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    return buildFailureResult(`Invalid input: ${field} must be a non-empty object.`);
  }
  return value;
}

const databaseSkill: SkillDefinition = {
  id: "database",
  version: "1.0.0",
  description: "Structured SQLite operations for schema inspection, table changes, row mutations, and queries.",
  tools: [
    withDatabaseContract(createListTablesTool(), "read"),
    withDatabaseContract(createDescribeTableTool(), "read"),
    withDatabaseContract(createGetTableDdlTool(), "read"),
    withDatabaseContract(createCreateTableTool(), "write"),
    withDatabaseContract(createRenameTableTool(), "write"),
    withDatabaseContract(createDropTableTool(), "destructive"),
    withDatabaseContract(createAddColumnsTool(), "write"),
    withDatabaseContract(createInsertRowsTool(), "write"),
    withDatabaseContract(createUpdateRowsTool(), "write"),
    withDatabaseContract(createDeleteRowsTool(), "destructive"),
    withDatabaseContract(createQueryTool(), "read"),
  ],
};

export default databaseSkill;
