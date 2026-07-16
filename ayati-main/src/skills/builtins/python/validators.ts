import { resolve as resolvePath } from "node:path";
import type { ToolResult } from "../../types.js";
import { requireAbsolutePath, resolveWorkspaceCwd } from "../../workspace-paths.js";
import { resolveDatabasePath } from "../../../database/sqlite-runtime.js";

export interface PythonInspectDatasetInput {
  sourceType: "path" | "sqlite_table" | "sqlite_query";
  path?: string;
  dbPath?: string;
  table?: string;
  sql?: string;
  sampleRows?: number;
  profileColumns?: boolean;
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface PythonExecuteInput {
  mode: "code" | "script";
  code?: string;
  scriptPath?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  inputFiles?: string[];
  sqliteDbPaths?: string[];
  targets?: PythonMutationTargetInput[];
}

export interface PythonMutationTargetInput {
  path: string;
  kind?: "file" | "directory";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResult(value: unknown): value is ToolResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

function absolutePath(value: string, field: string): string | ToolResult {
  const result = requireAbsolutePath(value, field);
  if (result.ok) return result.absolutePath;
  return {
    ok: false,
    error: result.message,
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code: result.code,
      message: result.message,
      error: {
        category: "validation",
        code: result.code,
        message: result.message,
        retryable: true,
        recoverable: true,
        target: value,
        suggestedNextActions: ["Use the active task workingDirectory to construct the complete absolute path and retry."],
      },
    },
  };
}

function absolutePaths(values: string[] | undefined, field: string): string[] | undefined | ToolResult {
  if (!values) return undefined;
  const paths: string[] = [];
  for (const [index, value] of values.entries()) {
    const path = absolutePath(value, `${field}[${index}]`);
    if (typeof path !== "string") return path;
    paths.push(path);
  }
  return paths;
}

function readMutationTargets(obj: Record<string, unknown>): PythonMutationTargetInput[] | undefined | ToolResult {
  const value = obj["targets"];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "Invalid input: targets must be a non-empty array when provided." };
  }
  const targets: PythonMutationTargetInput[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry) || typeof entry["path"] !== "string") {
      return { ok: false, error: `Invalid input: targets[${index}].path must be a non-empty absolute path.` };
    }
    if (entry["kind"] !== undefined && entry["kind"] !== "file" && entry["kind"] !== "directory") {
      return { ok: false, error: `Invalid input: targets[${index}].kind must be file or directory.` };
    }
    const path = absolutePath(entry["path"], `targets[${index}].path`);
    if (typeof path !== "string") return path;
    targets.push({ path, ...(entry["kind"] ? { kind: entry["kind"] } : {}) });
  }
  return targets;
}

function readOptionalString(obj: Record<string, unknown>, key: string): string | undefined | ToolResult {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return { ok: false, error: `Invalid input: ${key} must be a string when provided.` };
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined | ToolResult {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return { ok: false, error: `Invalid input: ${key} must be an array of strings when provided.` };
  }
  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function readOptionalNumber(obj: Record<string, unknown>, key: string): number | undefined | ToolResult {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { ok: false, error: `Invalid input: ${key} must be a positive number when provided.` };
  }
  return Math.trunc(value);
}

function readOptionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined | ToolResult {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    return { ok: false, error: `Invalid input: ${key} must be a boolean when provided.` };
  }
  return value;
}

export function resolvePythonPath(pathValue: string, cwd?: string, rootPath?: string): string {
  const resolvedCwd = resolveWorkspaceCwd(cwd, rootPath);
  return resolvePath(resolvedCwd, pathValue);
}

export function validatePythonInspectDatasetInput(
  input: unknown,
  _rootPath?: string,
): PythonInspectDatasetInput | ToolResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: "Invalid input: expected object." };
  }

  const sourceType = input["sourceType"];
  if (sourceType !== "path" && sourceType !== "sqlite_table" && sourceType !== "sqlite_query") {
    return { ok: false, error: "Invalid input: sourceType must be path, sqlite_table, or sqlite_query." };
  }

  const cwd = readOptionalString(input, "cwd");
  if (typeof cwd === "object") return cwd;
  const absoluteCwd = cwd === undefined ? undefined : absolutePath(cwd, "cwd");
  if (absoluteCwd !== undefined && typeof absoluteCwd !== "string") return absoluteCwd;
  const timeoutMs = readOptionalNumber(input, "timeoutMs");
  if (typeof timeoutMs === "object") return timeoutMs;
  const maxOutputChars = readOptionalNumber(input, "maxOutputChars");
  if (typeof maxOutputChars === "object") return maxOutputChars;
  const sampleRows = readOptionalNumber(input, "sampleRows");
  if (typeof sampleRows === "object") return sampleRows;
  const profileColumns = readOptionalBoolean(input, "profileColumns");
  if (typeof profileColumns === "object") return profileColumns;

  if (sourceType === "path") {
    const pathValue = readOptionalString(input, "path");
    if (typeof pathValue === "object") return pathValue;
    if (!pathValue) {
      return { ok: false, error: "Invalid input: path is required when sourceType is path." };
    }
    const path = absolutePath(pathValue, "path");
    if (typeof path !== "string") return path;
    return {
      sourceType,
      path,
      cwd: absoluteCwd,
      timeoutMs,
      maxOutputChars,
      sampleRows,
      profileColumns,
    };
  }

  const dbPath = readOptionalString(input, "dbPath");
  if (typeof dbPath === "object") return dbPath;
  const absoluteDbPath = dbPath === undefined ? undefined : absolutePath(dbPath, "dbPath");
  if (absoluteDbPath !== undefined && typeof absoluteDbPath !== "string") return absoluteDbPath;

  if (sourceType === "sqlite_table") {
    const table = readOptionalString(input, "table");
    if (typeof table === "object") return table;
    if (!table) {
      return { ok: false, error: "Invalid input: table is required when sourceType is sqlite_table." };
    }
    return {
      sourceType,
      dbPath: resolveDatabasePath(absoluteDbPath),
      table,
      cwd: absoluteCwd,
      timeoutMs,
      maxOutputChars,
      sampleRows,
      profileColumns,
    };
  }

  const sql = readOptionalString(input, "sql");
  if (typeof sql === "object") return sql;
  if (!sql) {
    return { ok: false, error: "Invalid input: sql is required when sourceType is sqlite_query." };
  }
  return {
    sourceType,
    dbPath: resolveDatabasePath(absoluteDbPath),
    sql,
    cwd: absoluteCwd,
    timeoutMs,
    maxOutputChars,
    sampleRows,
    profileColumns,
  };
}

export function validatePythonExecuteInput(
  input: unknown,
  _rootPath?: string,
): PythonExecuteInput | ToolResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: "Invalid input: expected object." };
  }

  const mode = input["mode"];
  if (mode !== "code" && mode !== "script") {
    return { ok: false, error: "Invalid input: mode must be code or script." };
  }

  const cwd = readOptionalString(input, "cwd");
  if (typeof cwd === "object") return cwd;
  const absoluteCwd = cwd === undefined ? undefined : absolutePath(cwd, "cwd");
  if (absoluteCwd !== undefined && typeof absoluteCwd !== "string") return absoluteCwd;
  const timeoutMs = readOptionalNumber(input, "timeoutMs");
  if (typeof timeoutMs === "object") return timeoutMs;
  const maxOutputChars = readOptionalNumber(input, "maxOutputChars");
  if (typeof maxOutputChars === "object") return maxOutputChars;
  const args = readOptionalStringArray(input, "args");
  if (isToolResult(args)) return args;
  const inputFiles = readOptionalStringArray(input, "inputFiles");
  if (isToolResult(inputFiles)) return inputFiles;
  const sqliteDbPaths = readOptionalStringArray(input, "sqliteDbPaths");
  if (isToolResult(sqliteDbPaths)) return sqliteDbPaths;
  const absoluteInputFiles = absolutePaths(inputFiles, "inputFiles");
  if (isToolResult(absoluteInputFiles)) return absoluteInputFiles;
  const absoluteSqliteDbPaths = absolutePaths(sqliteDbPaths, "sqliteDbPaths");
  if (isToolResult(absoluteSqliteDbPaths)) return absoluteSqliteDbPaths;
  const targets = readMutationTargets(input);
  if (isToolResult(targets)) return targets;

  if (mode === "code") {
    const code = readOptionalString(input, "code");
    if (typeof code === "object") return code;
    if (!code) {
      return { ok: false, error: "Invalid input: code is required when mode is code." };
    }
    return {
      mode,
      code,
      cwd: absoluteCwd,
      timeoutMs,
      maxOutputChars,
      args,
      inputFiles: absoluteInputFiles,
      sqliteDbPaths: absoluteSqliteDbPaths,
      targets,
    };
  }

  const scriptPath = readOptionalString(input, "scriptPath");
  if (typeof scriptPath === "object") return scriptPath;
  if (!scriptPath) {
    return { ok: false, error: "Invalid input: scriptPath is required when mode is script." };
  }
  const absoluteScriptPath = absolutePath(scriptPath, "scriptPath");
  if (typeof absoluteScriptPath !== "string") return absoluteScriptPath;

  return {
    mode,
    scriptPath: absoluteScriptPath,
    cwd: absoluteCwd,
    timeoutMs,
    maxOutputChars,
    args,
    inputFiles: absoluteInputFiles,
    sqliteDbPaths: absoluteSqliteDbPaths,
    targets,
  };
}
