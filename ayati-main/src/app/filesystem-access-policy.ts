import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "../skills/types.js";
import {
  canonicalizeAbsoluteFilesystemPath,
  requireAbsoluteFilesystemPath,
} from "../shared/filesystem-paths.js";

export type FilesystemReadScope = "workspace" | "machine";
export type FilesystemMutationScope = "workspace" | "bound_resource";

export interface FilesystemAccessPolicy {
  readScope: FilesystemReadScope;
  mutationScope: FilesystemMutationScope;
}

export const DEFAULT_FILESYSTEM_ACCESS_POLICY: FilesystemAccessPolicy = {
  readScope: "machine",
  mutationScope: "workspace",
};

const MACHINE_FILESYSTEM_READ_TOOLS = new Set([
  "read_files",
  "inspect_paths",
  "list_directory",
  "find_files",
  "search_in_files",
]);

const DIRECT_FILESYSTEM_MUTATION_TOOLS = new Set([
  "write_files",
  "patch_files",
  "create_directory",
  "copy",
  "move",
  "delete",
  "set_permissions",
]);

const TARGET_VERIFIED_FILESYSTEM_MUTATION_TOOLS = new Set([
  "write_files",
  "patch_files",
  "create_directory",
  "copy",
  "move",
  "delete",
  "set_permissions",
]);

const PROCESS_MUTATION_TOOLS = new Set([
  "process_run",
]);

export interface FilesystemAccessPolicyFailure {
  code:
    | "ABSOLUTE_PATH_REQUIRED"
    | "PATH_OUTSIDE_MUTATION_WORKSPACE"
    | "PATH_OUTSIDE_SELECTED_MUTATION_ROOT";
  message: string;
  target?: string;
}

export interface SelectedFilesystemMutationRoot {
  executionRootPath: string;
  authorityPath: string;
  authorityKind: "file" | "directory";
}

export function loadFilesystemAccessPolicy(
  env: NodeJS.ProcessEnv = process.env,
): FilesystemAccessPolicy {
  return {
    readScope: readPolicyValue(
      env["AYATI_FILESYSTEM_READ_SCOPE"],
      ["workspace", "machine"],
      DEFAULT_FILESYSTEM_ACCESS_POLICY.readScope,
      "AYATI_FILESYSTEM_READ_SCOPE",
    ),
    mutationScope: readPolicyValue(
      env["AYATI_FILESYSTEM_MUTATION_SCOPE"],
      ["workspace", "bound_resource"],
      DEFAULT_FILESYSTEM_ACCESS_POLICY.mutationScope,
      "AYATI_FILESYSTEM_MUTATION_SCOPE",
    ),
  };
}

export function isMachineFilesystemReadTool(
  toolName: string,
  definition: ToolDefinition | undefined,
  policy: FilesystemAccessPolicy,
): boolean {
  return policy.readScope === "machine"
    && MACHINE_FILESYSTEM_READ_TOOLS.has(toolName)
    && definition?.annotations?.domain === "filesystem"
    && definition.annotations.readOnly;
}

export function usesSelectedFilesystemMutationRoot(toolName: string): boolean {
  return TARGET_VERIFIED_FILESYSTEM_MUTATION_TOOLS.has(toolName);
}

export async function selectFilesystemMutationRoot(input: {
  toolName: string;
  value: unknown;
  roots: string[];
}): Promise<
  | { selection: SelectedFilesystemMutationRoot }
  | { failure: FilesystemAccessPolicyFailure }
> {
  const roots: string[] = [];
  for (const root of input.roots) {
    const required = requireAbsoluteFilesystemPath(root, "mutationScopes[].path");
    if (!required.ok) {
      return {
        failure: {
          code: required.code,
          message: required.message,
          target: root,
        },
      };
    }
    roots.push(await canonicalizeAbsoluteFilesystemPath(required.absolutePath));
  }

  const paths: string[] = [];
  for (const path of collectMutationPolicyPaths(input.toolName, input.value)) {
    const required = requireAbsoluteFilesystemPath(path);
    if (!required.ok) {
      return {
        failure: {
          code: required.code,
          message: required.message,
          target: path,
        },
      };
    }
    paths.push(await canonicalizeAbsoluteFilesystemPath(required.absolutePath));
  }

  const selected = roots
    .sort((left, right) => right.length - left.length)
    .find((root) => paths.every((path) => isWithin(root, path)));
  if (!selected) {
    const target = paths[0];
    return {
      failure: {
        code: "PATH_OUTSIDE_SELECTED_MUTATION_ROOT",
        message: "Every path in one filesystem mutation call must stay inside one selected absolute destination root.",
        ...(target ? { target } : {}),
      },
    };
  }
  const authorityKind = input.toolName !== "create_directory"
    && paths.length > 0
    && paths.every((path) => path === selected)
    ? "file"
    : "directory";
  return {
    selection: {
      executionRootPath: authorityKind === "file" ? dirname(selected) : selected,
      authorityPath: selected,
      authorityKind,
    },
  };
}

export function validateMachineReadPaths(
  toolName: string,
  value: unknown,
): FilesystemAccessPolicyFailure | undefined {
  for (const path of collectMachineReadPaths(toolName, value)) {
    const required = requireAbsoluteFilesystemPath(path);
    if (!required.ok) {
      return {
        code: required.code,
        message: required.message,
        target: path,
      };
    }
  }
  return undefined;
}

export async function validateWorkspaceMutationPaths(input: {
  toolName: string;
  value: unknown;
  workspaceRoot: string;
}): Promise<FilesystemAccessPolicyFailure | undefined> {
  const workspaceRoot = await canonicalizeAbsoluteFilesystemPath(input.workspaceRoot);
  for (const path of collectMutationPolicyPaths(input.toolName, input.value)) {
    const required = requireAbsoluteFilesystemPath(path);
    if (!required.ok) {
      return {
        code: required.code,
        message: required.message,
        target: path,
      };
    }
    const candidate = await canonicalizeAbsoluteFilesystemPath(required.absolutePath);
    if (!isWithin(workspaceRoot, candidate)) {
      return {
        code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
        message: `Mutation path is outside the configured Ayati workspace ${workspaceRoot}: ${candidate}`,
        target: candidate,
      };
    }
  }
  return undefined;
}

/**
 * Direct filesystem mutation paths may be relative to the configured
 * workspace. Resolve them once before resource selection and containment
 * checks so every later gate sees the same absolute target. Absolute paths
 * remain unchanged and are still rejected when they fall outside policy.
 */
export function resolveWorkspaceMutationInput(
  toolName: string,
  value: unknown,
  workspaceRoot: string,
): unknown {
  if (!DIRECT_FILESYSTEM_MUTATION_TOOLS.has(toolName) || !isRecord(value)) {
    return value;
  }
  const input = structuredClone(value);
  const resolvePath = (path: unknown): unknown => {
    if (!isNonEmptyString(path)) return path;
    const normalized = path.trim();
    if (
      isAbsolute(normalized)
      || normalized === "~"
      || normalized.startsWith("~/")
      || normalized.startsWith("~\\")
      || /^file:/i.test(normalized)
      || /^[A-Za-z]:[\\/]/.test(normalized)
    ) {
      return normalized;
    }
    return resolve(workspaceRoot, normalized);
  };
  for (const key of PATH_KEYS) {
    if (key in input) input[key] = resolvePath(input[key]);
  }
  for (const key of STRING_ARRAY_PATH_KEYS) {
    if (Array.isArray(input[key])) {
      input[key] = (input[key] as unknown[]).map(resolvePath);
    }
  }
  for (const key of OBJECT_ARRAY_PATH_KEYS) {
    if (!Array.isArray(input[key])) continue;
    input[key] = (input[key] as unknown[]).map((entry) => {
      if (!isRecord(entry)) return entry;
      const record = { ...entry };
      for (const pathKey of ENTRY_PATH_KEYS) {
        if (pathKey in record) record[pathKey] = resolvePath(record[pathKey]);
      }
      return record;
    });
  }
  return input;
}

export function collectToolPaths(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const direct = PATH_KEYS.map((key) => value[key])
    .filter(isNonEmptyString);
  const arrays = ARRAY_PATH_KEYS.flatMap((key) => {
    const entries = value[key];
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      if (isNonEmptyString(entry)) return [entry];
      if (!isRecord(entry)) return [];
      return ENTRY_PATH_KEYS.map((key) => entry[key]).filter(isNonEmptyString);
    });
  });
  return uniqueStrings([...direct, ...arrays]);
}

export function scopeToolInput(
  toolName: string,
  value: unknown,
  executionRootPath: string,
): unknown {
  if (!isRecord(value)) return value;
  const input = structuredClone(value);
  delete input["allowExternalPath"];
  const scope = (path: unknown): unknown => {
    if (!isNonEmptyString(path) || !isAbsolute(path)) return path;
    return resolve(path);
  };
  for (const key of PATH_KEYS) {
    if (key in input) input[key] = scope(input[key]);
  }
  for (const key of STRING_ARRAY_PATH_KEYS) {
    if (Array.isArray(input[key])) {
      input[key] = (input[key] as unknown[]).map(scope);
    }
  }
  for (const key of OBJECT_ARRAY_PATH_KEYS) {
    if (!Array.isArray(input[key])) continue;
    input[key] = (input[key] as unknown[]).map((entry) => {
      if (!isRecord(entry)) return entry;
      const record = { ...entry };
      for (const pathKey of ENTRY_PATH_KEYS) {
        if (pathKey in record) record[pathKey] = scope(record[pathKey]);
      }
      return record;
    });
  }
  if (
    (toolName === "process_run" || toolName === "process_start")
    && !("cwd" in input)
  ) {
    input["cwd"] = executionRootPath;
  }
  return input;
}

function collectMachineReadPaths(toolName: string, value: unknown): string[] {
  if (!MACHINE_FILESYSTEM_READ_TOOLS.has(toolName)) return [];
  return collectToolPaths(value);
}

function collectMutationPolicyPaths(toolName: string, value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (toolName === "copy") {
    return readDirectPaths(value, ["destination"]);
  }
  if (DIRECT_FILESYSTEM_MUTATION_TOOLS.has(toolName)) {
    return collectToolPaths(value);
  }
  if (toolName === "process_start") {
    return readDirectPaths(value, ["cwd"]);
  }
  if (PROCESS_MUTATION_TOOLS.has(toolName)) {
    return uniqueStrings([
      ...readDirectPaths(value, ["cwd"]),
      ...readObjectArrayPaths(value["targets"]),
    ]);
  }
  if (toolName === "python_execute") {
    return uniqueStrings([
      ...readDirectPaths(value, ["cwd"]),
      ...readObjectArrayPaths(value["targets"]),
    ]);
  }
  if (toolName.startsWith("db_")) {
    return readDirectPaths(value, ["dbPath"]);
  }
  if (toolName === "dataset_promote_table") {
    return readDirectPaths(value, ["targetDbPath"]);
  }
  return collectToolPaths(value);
}

function readDirectPaths(
  value: Record<string, unknown>,
  keys: string[],
): string[] {
  return keys.map((key) => value[key]).filter(isNonEmptyString);
}

function readObjectArrayPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (
    isRecord(entry) && isNonEmptyString(entry["path"])
      ? [entry["path"]]
      : []
  ));
}

function readPolicyValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  variable: string,
): T {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if ((allowed as readonly string[]).includes(normalized)) {
    return normalized as T;
  }
  throw new Error(
    `${variable} must be one of ${allowed.join(", ")}; received ${JSON.stringify(normalized)}.`,
  );
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), resolve(candidate));
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

const PATH_KEYS = [
  "path",
  "from",
  "to",
  "source",
  "destination",
  "target",
  "cwd",
  "workdir",
  "scriptPath",
  "dbPath",
  "targetDbPath",
] as const;

const STRING_ARRAY_PATH_KEYS = [
  "paths",
  "roots",
  "inputFiles",
  "sqliteDbPaths",
] as const;

const OBJECT_ARRAY_PATH_KEYS = [
  "files",
  "edits",
  "targets",
] as const;

const ARRAY_PATH_KEYS = [
  ...STRING_ARRAY_PATH_KEYS,
  ...OBJECT_ARRAY_PATH_KEYS,
] as const;

const ENTRY_PATH_KEYS = ["path", "from", "to"] as const;
