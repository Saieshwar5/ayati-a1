import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import {
  addColumns,
  createTable,
  deleteRows,
  describeTable,
  dropTable,
  executeSql,
  getTableDdl,
  insertRows,
  listTables,
  queryTable,
  renameTable,
  updateRows,
} from "../../../database/sqlite-runtime.js";
import type { DatabaseColumnInput, DatabaseToolMode } from "../../../database/sqlite-runtime.js";

const DATABASE_PROMPT_BLOCK = [
  "SQLite database tools are built in.",
  "Use them directly for local, structured database work.",
  "Default database path: data/sqlite/agent.sqlite.",
  "Prefer structured tools for common tasks because they are easier and more reliable for the agent.",
  "Use db_execute_sql when you need joins, aggregations, migrations, or any advanced SQLite feature not covered by the structured tools.",
  "Inspect schema before mutating an unfamiliar table.",
  "Keep result sets compact unless the user explicitly asks for a larger dump.",
  "Tools: db_list_tables, db_describe_table, db_get_table_ddl, db_create_table, db_rename_table, db_drop_table, db_add_columns, db_insert_rows, db_update_rows, db_delete_rows, db_query, db_execute_sql.",
].join("\n");

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

function createListTablesTool(): ToolDefinition {
  return {
    name: "db_list_tables",
    description: "List user tables in a SQLite database with row counts and create SQL.",
    inputSchema: {
      type: "object",
      properties: {
        dbPath: { type: "string", description: "Optional SQLite database path. Defaults to data/sqlite/agent.sqlite." },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "schema", "tables", "list"],
      aliases: ["list_tables", "show_tables"],
      examples: ["show database tables", "what tables exist"],
      domain: "database",
      priority: 5,
    },
    async execute(input): Promise<ToolResult> {
      const payload = isPlainObject(input) ? input : {};
      const dbPath = readOptionalString(payload, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
        table: { type: "string", description: "Table name to describe." },
        sampleLimit: { type: "number", description: "Optional sample row limit (default 50, max 200)." },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "schema", "table", "describe"],
      aliases: ["describe_table", "show_schema", "inspect_table"],
      examples: ["describe users table", "show table columns"],
      domain: "database",
      priority: 5,
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const sampleLimit = readOptionalNumber(input, "sampleLimit");
      if (isToolResult(sampleLimit)) return sampleLimit;
      const dbPath = readOptionalString(input, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
        table: { type: "string", description: "Table name." },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "ddl", "schema"],
      aliases: ["table_ddl", "show_create_table"],
      examples: ["get create table sql", "show table ddl"],
      domain: "database",
      priority: 4,
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const dbPath = readOptionalString(input, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
        table: { type: "string", description: "Table name to create." },
        ifNotExists: { type: "boolean", description: "Create only when missing. Defaults to true." },
        columns: {
          type: "array",
          description: "Column definitions for the new table.",
          items: DATABASE_COLUMN_SCHEMA,
        },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "create", "table"],
      aliases: ["create_table", "new_table"],
      examples: ["create a customers table", "make a table for CSV rows"],
      domain: "database",
      priority: 5,
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const dbPath = readOptionalString(input, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
        table: { type: "string", description: "Current table name." },
        newName: { type: "string", description: "New table name." },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "rename", "table"],
      aliases: ["rename_table"],
      examples: ["rename the temp table", "change table name"],
      domain: "database",
      priority: 4,
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const newName = readRequiredString(input, "newName");
      if (isToolResult(newName)) return newName;
      const dbPath = readOptionalString(input, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
        table: { type: "string", description: "Table name to drop." },
        ifExists: { type: "boolean", description: "Ignore missing tables when true." },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "drop", "delete", "table"],
      aliases: ["delete_table"],
      examples: ["drop the staging table", "remove old table"],
      domain: "database",
      priority: 4,
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const ifExists = readOptionalBoolean(input, "ifExists");
      if (isToolResult(ifExists)) return ifExists;
      const dbPath = readOptionalString(input, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
        table: { type: "string", description: "Table name." },
        columns: {
          type: "array",
          description: "Column definitions to add.",
          items: DATABASE_COLUMN_SCHEMA,
        },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "alter", "columns", "schema"],
      aliases: ["alter_table_add_columns", "add_columns"],
      examples: ["add email column", "extend schema"],
      domain: "database",
      priority: 5,
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const columns = readRequiredArray(input, "columns");
      if (isToolResult(columns)) return columns;
      const dbPath = readOptionalString(input, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
        table: { type: "string", description: "Table name." },
        rows: {
          type: "array",
          description: "Rows to insert as objects keyed by column name.",
          items: DATABASE_ROW_OBJECT_SCHEMA,
        },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "insert", "rows"],
      aliases: ["insert_rows", "add_rows"],
      examples: ["insert these records", "save rows into table"],
      domain: "database",
      priority: 5,
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const rows = readRequiredArray(input, "rows");
      if (isToolResult(rows)) return rows;
      const dbPath = readOptionalString(input, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
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
    selectionHints: {
      tags: ["database", "sqlite", "update", "rows"],
      aliases: ["update_rows", "edit_rows"],
      examples: ["update matching rows", "set status to done"],
      domain: "database",
      priority: 5,
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
      const dbPath = readOptionalString(input, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
        table: { type: "string", description: "Table name." },
        whereSql: { type: "string", description: "Optional SQL after WHERE, such as created_at < ?." },
        params: {
          type: "array",
          description: "Optional positional parameters for whereSql.",
          items: GENERIC_JSON_VALUE_SCHEMA,
        },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "delete", "rows"],
      aliases: ["remove_rows", "delete_rows"],
      examples: ["delete matching rows", "remove old records"],
      domain: "database",
      priority: 5,
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const table = readRequiredString(input, "table");
      if (isToolResult(table)) return table;
      const whereSql = readOptionalString(input, "whereSql");
      const params = readOptionalArray(input, "params");
      if (isToolResult(params)) return params;
      const dbPath = readOptionalString(input, "dbPath");
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
        dbPath: { type: "string", description: "Optional SQLite database path." },
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
    selectionHints: {
      tags: ["database", "sqlite", "query", "select", "rows"],
      aliases: ["select_rows", "read_rows"],
      examples: ["query the latest rows", "show rows with status open"],
      domain: "database",
      priority: 5,
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
      const dbPath = readOptionalString(input, "dbPath");

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

function createExecuteSqlTool(): ToolDefinition {
  return {
    name: "db_execute_sql",
    description: "Execute raw SQLite SQL directly. Use mode=query for SELECT/RETURNING statements and mode=execute for DDL/DML or multi-statement SQL.",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: {
        dbPath: { type: "string", description: "Optional SQLite database path." },
        sql: { type: "string", description: "SQL to execute." },
        params: {
          type: "array",
          description: "Optional positional parameters for a single prepared statement.",
          items: GENERIC_JSON_VALUE_SCHEMA,
        },
        mode: { type: "string", description: "auto, query, or execute." },
        maxRows: { type: "number", description: "Optional row cap for query mode (default 50, max 200)." },
      },
    },
    selectionHints: {
      tags: ["database", "sqlite", "sql", "ddl", "dml", "query"],
      aliases: ["execute_sql", "run_sql", "raw_sql"],
      examples: ["run this SQL", "execute an ALTER TABLE", "perform a join query"],
      domain: "database",
      priority: 5,
    },
    async execute(input): Promise<ToolResult> {
      if (!isPlainObject(input)) return buildFailureResult("Invalid input: expected object.");
      const sql = readRequiredString(input, "sql");
      if (isToolResult(sql)) return sql;
      const params = readOptionalArray(input, "params");
      if (isToolResult(params)) return params;
      const mode = readOptionalMode(input, "mode");
      if (isToolResult(mode)) return mode;
      const maxRows = readOptionalNumber(input, "maxRows");
      if (isToolResult(maxRows)) return maxRows;
      const dbPath = readOptionalString(input, "dbPath");
      const result = executeSql({
        dbPath,
        sql,
        ...(Array.isArray(params) ? { params } : {}),
        ...(typeof mode === "string" ? { mode } : {}),
        ...(typeof maxRows === "number" ? { maxRows } : {}),
      });
      return result.ok
        ? buildSuccessResult(result.data, { statementType: result.data?.statementType })
        : buildFailureResult(result.error ?? "Failed to execute SQL.");
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

function readOptionalMode(input: Record<string, unknown>, field: string): DatabaseToolMode | ToolResult | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (value === "auto" || value === "query" || value === "execute") {
    return value;
  }
  return buildFailureResult(`Invalid input: ${field} must be one of auto, query, or execute.`);
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
  description: "SQLite database operations — inspect schema, create/alter tables, insert/update/delete rows, query data, and execute raw SQL.",
  promptBlock: DATABASE_PROMPT_BLOCK,
  tools: [
    createListTablesTool(),
    createDescribeTableTool(),
    createGetTableDdlTool(),
    createCreateTableTool(),
    createRenameTableTool(),
    createDropTableTool(),
    createAddColumnsTool(),
    createInsertRowsTool(),
    createUpdateRowsTool(),
    createDeleteRowsTool(),
    createQueryTool(),
    createExecuteSqlTool(),
  ],
};

export default databaseSkill;
