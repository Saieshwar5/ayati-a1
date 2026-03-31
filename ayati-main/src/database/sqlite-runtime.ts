import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_DB_PATH = resolve(projectRoot, "data", "sqlite", "agent.sqlite");
const MAX_DEFAULT_ROWS = 50;
const MAX_ALLOWED_ROWS = 200;
const MAX_CELL_CHARS = 2_000;

export type DatabaseToolMode = "auto" | "query" | "execute";

export interface DatabaseColumnInput {
  name: string;
  type?: string;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  defaultValue?: string | number | boolean | null;
  defaultSql?: string;
  references?: {
    table: string;
    column: string;
  };
  check?: string;
}

export interface DatabaseExecutionSummary {
  dbPath: string;
  statementType: "query" | "run" | "exec";
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
  truncated?: boolean;
  columns?: string[];
  changes?: number;
  lastInsertRowid?: string | number | null;
}

export interface DatabaseTableSummary {
  name: string;
  rowCount: number;
  sql: string | null;
}

export interface DatabaseTableDescription {
  name: string;
  rowCount: number;
  createSql: string | null;
  columns: Array<{
    cid: number;
    name: string;
    type: string;
    notNull: boolean;
    defaultValue: string | null;
    primaryKeyOrdinal: number;
  }>;
  indexes: Array<{
    seq: number;
    name: string;
    unique: boolean;
    origin: string;
    partial: boolean;
  }>;
  foreignKeys: Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    onUpdate: string;
    onDelete: string;
    match: string;
  }>;
  sampleRows: Array<Record<string, unknown>>;
  sampleTruncated: boolean;
}

export interface CreateTableInput {
  dbPath?: string;
  table: string;
  columns: DatabaseColumnInput[];
  ifNotExists?: boolean;
}

export interface RenameTableInput {
  dbPath?: string;
  table: string;
  newName: string;
}

export interface DropTableInput {
  dbPath?: string;
  table: string;
  ifExists?: boolean;
}

export interface AddColumnsInput {
  dbPath?: string;
  table: string;
  columns: DatabaseColumnInput[];
}

export interface InsertRowsInput {
  dbPath?: string;
  table: string;
  rows: Array<Record<string, unknown>>;
}

export interface UpdateRowsInput {
  dbPath?: string;
  table: string;
  set: Record<string, unknown>;
  whereSql?: string;
  params?: unknown[];
}

export interface DeleteRowsInput {
  dbPath?: string;
  table: string;
  whereSql?: string;
  params?: unknown[];
}

export interface QueryTableInput {
  dbPath?: string;
  table: string;
  columns?: string[];
  whereSql?: string;
  params?: unknown[];
  orderBy?: string[];
  limit?: number;
  offset?: number;
}

export interface ExecuteSqlInput {
  dbPath?: string;
  sql: string;
  params?: unknown[];
  mode?: DatabaseToolMode;
  maxRows?: number;
}

export interface DatabaseResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function resolveDatabasePath(dbPath?: string): string {
  if (!dbPath || dbPath.trim().length === 0) {
    return DEFAULT_DB_PATH;
  }

  const trimmed = dbPath.trim();
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
}

export function listTables(dbPath?: string): DatabaseResult<{
  dbPath: string;
  tables: DatabaseTableSummary[];
}> {
  return withDatabase(dbPath, (db, resolvedPath) => {
    const rows = db.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all() as Array<{ name: string; sql: string | null }>;

    const tables = rows.map((row) => ({
      name: row.name,
      rowCount: getTableRowCount(db, row.name),
      sql: row.sql ?? null,
    }));

    return {
      dbPath: resolvedPath,
      tables,
    };
  });
}

export function describeTable(input: { dbPath?: string; table: string; sampleLimit?: number }): DatabaseResult<DatabaseTableDescription> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    ensureTableExists(db, tableName);
    const sampleLimit = clampRows(input.sampleLimit);
    const quotedTable = quoteIdentifier(tableName);
    const sample = collectRows(
      db.prepare(`SELECT * FROM ${quotedTable} LIMIT ${sampleLimit + 1}`),
      [],
      sampleLimit,
    );

    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifierLiteral(tableName)})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const indexes = db.prepare(`PRAGMA index_list(${quoteIdentifierLiteral(tableName)})`).all() as Array<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifierLiteral(tableName)})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }>;
    const ddlRow = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(tableName) as { sql: string | null } | undefined;

    return {
      name: tableName,
      rowCount: getTableRowCount(db, tableName),
      createSql: ddlRow?.sql ?? null,
      columns: columns.map((column) => ({
        cid: Number(column.cid),
        name: String(column.name),
        type: String(column.type ?? ""),
        notNull: Number(column.notnull) === 1,
        defaultValue: column.dflt_value ?? null,
        primaryKeyOrdinal: Number(column.pk),
      })),
      indexes: indexes.map((index) => ({
        seq: Number(index.seq),
        name: String(index.name),
        unique: Number(index.unique) === 1,
        origin: String(index.origin),
        partial: Number(index.partial) === 1,
      })),
      foreignKeys: foreignKeys.map((fk) => ({
        id: Number(fk.id),
        seq: Number(fk.seq),
        table: String(fk.table),
        from: String(fk.from),
        to: String(fk.to),
        onUpdate: String(fk.on_update),
        onDelete: String(fk.on_delete),
        match: String(fk.match),
      })),
      sampleRows: sample.rows,
      sampleTruncated: sample.truncated,
    };
  });
}

export function getTableDdl(input: { dbPath?: string; table: string }): DatabaseResult<{
  dbPath: string;
  table: string;
  createSql: string | null;
}> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    ensureTableExists(db, tableName);
    const row = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(tableName) as { sql: string | null } | undefined;

    return {
      dbPath: resolvedPath,
      table: tableName,
      createSql: row?.sql ?? null,
    };
  });
}

export function createTable(input: CreateTableInput): DatabaseResult<{
  dbPath: string;
  table: string;
  sql: string;
}> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      throw new Error("columns must contain at least one column definition.");
    }

    const sql = [
      "CREATE TABLE",
      input.ifNotExists !== false ? "IF NOT EXISTS" : "",
      quoteIdentifier(tableName),
      `(${input.columns.map((column) => buildColumnDefinition(column, "create")).join(", ")})`,
    ].filter((part) => part.length > 0).join(" ");

    db.exec(sql);
    return {
      dbPath: resolvedPath,
      table: tableName,
      sql,
    };
  });
}

export function renameTable(input: RenameTableInput): DatabaseResult<{
  dbPath: string;
  table: string;
  newName: string;
}> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    const newName = requireIdentifier(input.newName, "newName");
    ensureTableExists(db, tableName);
    db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} RENAME TO ${quoteIdentifier(newName)}`);
    return {
      dbPath: resolvedPath,
      table: tableName,
      newName,
    };
  });
}

export function dropTable(input: DropTableInput): DatabaseResult<{
  dbPath: string;
  table: string;
  dropped: boolean;
}> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    const exists = tableExists(db, tableName);
    if (!exists && input.ifExists !== true) {
      throw new Error(`Table not found: ${tableName}`);
    }
    db.exec(`DROP TABLE ${input.ifExists === true ? "IF EXISTS " : ""}${quoteIdentifier(tableName)}`);
    return {
      dbPath: resolvedPath,
      table: tableName,
      dropped: exists,
    };
  });
}

export function addColumns(input: AddColumnsInput): DatabaseResult<{
  dbPath: string;
  table: string;
  addedColumns: string[];
}> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      throw new Error("columns must contain at least one column definition.");
    }
    ensureTableExists(db, tableName);
    const quotedTable = quoteIdentifier(tableName);
    for (const column of input.columns) {
      db.exec(`ALTER TABLE ${quotedTable} ADD COLUMN ${buildColumnDefinition(column, "alter")}`);
    }

    return {
      dbPath: resolvedPath,
      table: tableName,
      addedColumns: input.columns.map((column) => requireIdentifier(column.name, "column name")),
    };
  });
}

export function insertRows(input: InsertRowsInput): DatabaseResult<{
  dbPath: string;
  table: string;
  insertedRowCount: number;
  columns: string[];
}> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    const rows = requireRowArray(input.rows);
    ensureTableExists(db, tableName);
    const columns = collectRowColumns(rows);
    if (columns.length === 0) {
      throw new Error("rows must include at least one column.");
    }

    const placeholders = columns.map(() => "?").join(", ");
    const sql = `INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`;
    const statement = db.prepare(sql);

    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const values = columns.map((column) => encodeValue(row[column]));
        statement.run(...values);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    return {
      dbPath: resolvedPath,
      table: tableName,
      insertedRowCount: rows.length,
      columns,
    };
  });
}

export function updateRows(input: UpdateRowsInput): DatabaseResult<{
  dbPath: string;
  table: string;
  updatedRowCount: number;
}> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    const set = requirePlainObject(input.set, "set");
    const entries = Object.entries(set);
    if (entries.length === 0) {
      throw new Error("set must include at least one column.");
    }
    ensureTableExists(db, tableName);

    const assignments = entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(", ");
    const sql = `UPDATE ${quoteIdentifier(tableName)} SET ${assignments}${buildWhereClause(input.whereSql)}`;
    const statement = db.prepare(sql);
    const result = statement.run(
      ...entries.map(([, value]) => encodeValue(value)),
      ...encodeParams(input.params),
    ) as { changes?: number };

    return {
      dbPath: resolvedPath,
      table: tableName,
      updatedRowCount: Number(result.changes ?? 0),
    };
  });
}

export function deleteRows(input: DeleteRowsInput): DatabaseResult<{
  dbPath: string;
  table: string;
  deletedRowCount: number;
  whereApplied: boolean;
}> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    ensureTableExists(db, tableName);
    const sql = `DELETE FROM ${quoteIdentifier(tableName)}${buildWhereClause(input.whereSql)}`;
    const statement = db.prepare(sql);
    const result = statement.run(...encodeParams(input.params)) as { changes?: number };

    return {
      dbPath: resolvedPath,
      table: tableName,
      deletedRowCount: Number(result.changes ?? 0),
      whereApplied: typeof input.whereSql === "string" && input.whereSql.trim().length > 0,
    };
  });
}

export function queryTable(input: QueryTableInput): DatabaseResult<DatabaseExecutionSummary> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const tableName = requireIdentifier(input.table, "table");
    ensureTableExists(db, tableName);
    const limit = clampRows(input.limit);
    const offset = clampOffset(input.offset);
    const selectedColumns = (Array.isArray(input.columns) && input.columns.length > 0)
      ? input.columns.map((column) => quoteIdentifier(requireIdentifier(column, "column")))
      : ["*"];
    const orderBy = Array.isArray(input.orderBy) && input.orderBy.length > 0
      ? ` ORDER BY ${input.orderBy.map(normalizeOrderBy).join(", ")}`
      : "";
    const sql = [
      `SELECT ${selectedColumns.join(", ")} FROM ${quoteIdentifier(tableName)}`,
      buildWhereClause(input.whereSql),
      orderBy,
      ` LIMIT ${limit + 1}`,
      offset > 0 ? ` OFFSET ${offset}` : "",
    ].join("");
    const statement = db.prepare(sql);
    const queryResult = collectRows(statement, encodeParams(input.params), limit);

    return {
      dbPath: resolvedPath,
      statementType: "query",
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      truncated: queryResult.truncated,
      columns: queryResult.columns,
    };
  });
}

export function executeSql(input: ExecuteSqlInput): DatabaseResult<DatabaseExecutionSummary> {
  return withDatabase(input.dbPath, (db, resolvedPath) => {
    const sql = requireNonEmptyString(input.sql, "sql");
    const params = encodeParams(input.params);
    const mode = input.mode ?? "auto";
    const maxRows = clampRows(input.maxRows);

    if (mode === "execute") {
      if (params.length > 0 && hasMultipleStatements(sql)) {
        throw new Error("params are only supported for a single prepared statement.");
      }
      if (params.length > 0) {
        const statement = db.prepare(sql);
        const result = statement.run(...params) as { changes?: number; lastInsertRowid?: string | number | null };
        return {
          dbPath: resolvedPath,
          statementType: "run",
          changes: Number(result.changes ?? 0),
          lastInsertRowid: result.lastInsertRowid ?? null,
        };
      }

      db.exec(sql);
      return {
        dbPath: resolvedPath,
        statementType: "exec",
        changes: 0,
      };
    }

    const queryMode = mode === "query" || (mode === "auto" && looksLikeQuery(sql));
    if (!queryMode) {
      const statement = db.prepare(sql);
      const result = statement.run(...params) as { changes?: number; lastInsertRowid?: string | number | null };
      return {
        dbPath: resolvedPath,
        statementType: "run",
        changes: Number(result.changes ?? 0),
        lastInsertRowid: result.lastInsertRowid ?? null,
      };
    }

    if (hasMultipleStatements(sql)) {
      throw new Error("query mode supports a single statement only.");
    }

    const statement = db.prepare(sql);
    const queryResult = collectRows(statement, params, maxRows);
    return {
      dbPath: resolvedPath,
      statementType: "query",
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      truncated: queryResult.truncated,
      columns: queryResult.columns,
    };
  });
}

function withDatabase<T>(dbPath: string | undefined, handler: (db: DatabaseSync, resolvedPath: string) => T): DatabaseResult<T> {
  const resolvedPath = resolveDatabasePath(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(resolvedPath);
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA synchronous=NORMAL;");
    db.exec("PRAGMA foreign_keys=ON;");
    return {
      ok: true,
      data: handler(db, resolvedPath),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { present?: number } | undefined;
  return row?.present === 1;
}

function ensureTableExists(db: DatabaseSync, tableName: string): void {
  if (!tableExists(db, tableName)) {
    throw new Error(`Table not found: ${tableName}`);
  }
}

function getTableRowCount(db: DatabaseSync, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(tableName)}`).get() as { total?: number } | undefined;
  return Number(row?.total ?? 0);
}

function buildColumnDefinition(column: DatabaseColumnInput, mode: "create" | "alter"): string {
  const columnName = requireIdentifier(column.name, "column name");
  const parts = [quoteIdentifier(columnName)];

  if (column.type && column.type.trim().length > 0) {
    parts.push(validateTypeName(column.type));
  } else {
    parts.push("TEXT");
  }

  if (column.notNull === true) {
    parts.push("NOT NULL");
  }

  if (column.unique === true) {
    parts.push("UNIQUE");
  }

  if (mode === "create" && column.primaryKey === true) {
    parts.push("PRIMARY KEY");
  }

  if (column.defaultSql && column.defaultSql.trim().length > 0) {
    parts.push(`DEFAULT (${sanitizeSqlFragment(column.defaultSql, "defaultSql")})`);
  } else if (Object.prototype.hasOwnProperty.call(column, "defaultValue")) {
    parts.push(`DEFAULT ${encodeDefaultLiteral(column.defaultValue)}`);
  }

  if (column.references) {
    const refTable = requireIdentifier(column.references.table, "references.table");
    const refColumn = requireIdentifier(column.references.column, "references.column");
    parts.push(`REFERENCES ${quoteIdentifier(refTable)} (${quoteIdentifier(refColumn)})`);
  }

  if (column.check && column.check.trim().length > 0) {
    parts.push(`CHECK (${sanitizeSqlFragment(column.check, "check")})`);
  }

  return parts.join(" ");
}

function validateTypeName(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_ (),]*$/.test(normalized)) {
    throw new Error(`Unsupported column type: ${value}`);
  }
  return normalized;
}

function sanitizeSqlFragment(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty SQL fragment.`);
  }
  if (trimmed.includes(";")) {
    throw new Error(`${fieldName} must not contain semicolons.`);
  }
  return trimmed;
}

function encodeDefaultLiteral(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("defaultValue must be a finite number.");
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function requireRowArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("rows must be a non-empty array.");
  }
  return value.map((row, index) => requirePlainObject(row, `rows[${index}]`));
}

function collectRowColumns(rows: Array<Record<string, unknown>>): string[] {
  const ordered = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      requireIdentifier(key, "row column");
      ordered.add(key);
    }
  }
  return [...ordered];
}

function requirePlainObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function requireIdentifier(value: unknown, fieldName: string): string {
  const text = requireNonEmptyString(value, fieldName);
  if (text.includes("\u0000")) {
    throw new Error(`${fieldName} contains invalid characters.`);
  }
  return text;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function quoteIdentifierLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildWhereClause(whereSql?: string): string {
  if (!whereSql || whereSql.trim().length === 0) {
    return "";
  }
  return ` WHERE ${sanitizeSqlFragment(whereSql, "whereSql")}`;
}

function normalizeOrderBy(value: string): string {
  return sanitizeSqlFragment(value, "orderBy");
}

function clampRows(value?: number): number {
  if (!Number.isFinite(value) || typeof value !== "number") {
    return MAX_DEFAULT_ROWS;
  }
  return Math.max(1, Math.min(MAX_ALLOWED_ROWS, Math.floor(value)));
}

function clampOffset(value?: number): number {
  if (!Number.isFinite(value) || typeof value !== "number") {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function encodeParams(params?: unknown[]): SQLInputValue[] {
  if (!Array.isArray(params)) {
    return [];
  }
  return params.map((value) => encodeValue(value));
}

function encodeValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value;
  }
  return JSON.stringify(value);
}

function truncateCell(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= MAX_CELL_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_CELL_CHARS)}...[truncated]`;
}

function collectRows(
  statement: Pick<StatementSync, "columns" | "iterate">,
  params: SQLInputValue[],
  maxRows: number,
): { rows: Array<Record<string, unknown>>; truncated: boolean; columns: string[] } {
  const rows: Array<Record<string, unknown>> = [];
  let truncated = false;
  let count = 0;

  for (const row of statement.iterate(...params) as Iterable<Record<string, SQLOutputValue>>) {
    count++;
    if (count > maxRows) {
      truncated = true;
      break;
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] = truncateCell(value);
    }
    rows.push(normalized);
  }

  const columns = statement.columns().map((column) => String(column.name ?? ""));
  return { rows, truncated, columns };
}

function looksLikeQuery(sql: string): boolean {
  const normalized = sql.trim().toUpperCase();
  return normalized.startsWith("SELECT")
    || normalized.startsWith("WITH")
    || normalized.startsWith("PRAGMA")
    || normalized.startsWith("EXPLAIN");
}

function hasMultipleStatements(sql: string): boolean {
  const trimmed = sql.trim();
  const withoutTrailingSemicolons = trimmed.replace(/;+$/g, "");
  return withoutTrailingSemicolons.includes(";");
}
