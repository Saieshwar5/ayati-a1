import {
  requireAbsoluteFilesystemPath,
  requireResourceRelativePath,
} from "../../../shared/filesystem-paths.js";
import {
  GIT_READ_OPERATIONS,
  MAX_GIT_READ_CHARS,
  MAX_GIT_READ_LIMIT,
  type GitDiffScope,
  type GitReadInput,
  type GitReadOperation,
} from "./contracts.js";

type GitReadInputResult =
  | { ok: true; value: GitReadInput }
  | { ok: false; message: string };

const COMMON_FIELDS = ["repositoryPath", "operation"] as const;

const OPERATION_FIELDS: Record<GitReadOperation, readonly string[]> = {
  info: [],
  status: [],
  log: ["revision", "path", "limit"],
  show: ["revision", "path", "maxChars", "includePatch"],
  diff: ["baseRevision", "targetRevision", "path", "diffScope", "maxChars"],
  branches: ["limit"],
  tags: ["limit"],
  remotes: [],
  files: ["revision", "limit"],
  read_file: ["revision", "path", "maxChars"],
  grep: ["revision", "path", "query", "limit", "maxChars"],
  blame: ["revision", "path", "maxChars"],
  reflog: ["revision", "limit"],
  merge_base: ["baseRevision", "targetRevision"],
};

export function parseGitReadInput(input: unknown): GitReadInputResult {
  if (!isRecord(input)) {
    return invalid("git_read input must be an object.");
  }
  const repositoryPath = readRequiredString(input, "repositoryPath");
  if (!repositoryPath.ok) return repositoryPath;
  const absolute = requireAbsoluteFilesystemPath(repositoryPath.value, "repositoryPath");
  if (!absolute.ok) return invalid(absolute.message);

  const operationValue = readRequiredString(input, "operation");
  if (!operationValue.ok) return operationValue;
  if (!isGitReadOperation(operationValue.value)) {
    return invalid(`operation must be one of: ${GIT_READ_OPERATIONS.join(", ")}.`);
  }
  const operation = operationValue.value;
  const allowed = new Set<string>([...COMMON_FIELDS, ...OPERATION_FIELDS[operation]]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return invalid(`${operation} does not accept: ${unknown.join(", ")}.`);
  }

  const revision = readOptionalRevision(input, "revision");
  if (!revision.ok) return revision;
  const baseRevision = readOptionalRevision(input, "baseRevision");
  if (!baseRevision.ok) return baseRevision;
  const targetRevision = readOptionalRevision(input, "targetRevision");
  if (!targetRevision.ok) return targetRevision;
  const path = readOptionalPath(input, "path");
  if (!path.ok) return path;
  const query = readOptionalString(input, "query", 1_000);
  if (!query.ok) return query;
  const limit = readOptionalInteger(input, "limit", MAX_GIT_READ_LIMIT);
  if (!limit.ok) return limit;
  const maxChars = readOptionalInteger(input, "maxChars", MAX_GIT_READ_CHARS);
  if (!maxChars.ok) return maxChars;
  const includePatch = readOptionalBoolean(input, "includePatch");
  if (!includePatch.ok) return includePatch;
  const diffScope = readOptionalDiffScope(input);
  if (!diffScope.ok) return diffScope;

  const value: GitReadInput = {
    repositoryPath: absolute.absolutePath,
    operation,
    ...(revision.value ? { revision: revision.value } : {}),
    ...(baseRevision.value ? { baseRevision: baseRevision.value } : {}),
    ...(targetRevision.value ? { targetRevision: targetRevision.value } : {}),
    ...(path.value ? { path: path.value } : {}),
    ...(query.value ? { query: query.value } : {}),
    ...(diffScope.value ? { diffScope: diffScope.value } : {}),
    ...(limit.value !== undefined ? { limit: limit.value } : {}),
    ...(maxChars.value !== undefined ? { maxChars: maxChars.value } : {}),
    ...(includePatch.value !== undefined ? { includePatch: includePatch.value } : {}),
  };
  const operationError = validateOperationInput(value);
  return operationError ? invalid(operationError) : { ok: true, value };
}

function validateOperationInput(input: GitReadInput): string | undefined {
  if (input.operation === "show" && !input.revision) {
    return "show requires revision.";
  }
  if (input.operation === "read_file" && (!input.revision || !input.path)) {
    return "read_file requires revision and path.";
  }
  if (input.operation === "grep" && !input.query) {
    return "grep requires query.";
  }
  if (input.operation === "blame" && !input.path) {
    return "blame requires path.";
  }
  if (input.operation === "merge_base" && (!input.baseRevision || !input.targetRevision)) {
    return "merge_base requires baseRevision and targetRevision.";
  }
  if (input.operation !== "diff") return undefined;
  const scope = input.diffScope ?? (
    input.baseRevision || input.targetRevision ? "commits" : "working"
  );
  if (scope === "commits" && (!input.baseRevision || !input.targetRevision)) {
    return "A committed diff requires baseRevision and targetRevision.";
  }
  if (scope !== "commits" && (input.baseRevision || input.targetRevision)) {
    return `${scope} diff does not accept baseRevision or targetRevision.`;
  }
  return undefined;
}

function readRequiredString(
  input: Record<string, unknown>,
  field: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    return invalid(`${field} is required and must be a non-empty string.`);
  }
  return { ok: true, value: value.trim() };
}

function readOptionalString(
  input: Record<string, unknown>,
  field: string,
  maximumLength: number,
): { ok: true; value?: string } | { ok: false; message: string } {
  const value = input[field];
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    return invalid(`${field} must be a non-empty string of at most ${maximumLength} characters.`);
  }
  if (/\0/.test(value)) return invalid(`${field} may not contain NUL characters.`);
  return { ok: true, value: value.trim() };
}

function readOptionalRevision(
  input: Record<string, unknown>,
  field: string,
): { ok: true; value?: string } | { ok: false; message: string } {
  const parsed = readOptionalString(input, field, 200);
  if (!parsed.ok || !parsed.value) return parsed;
  if (parsed.value.startsWith("-") || /[\u0000-\u001f\u007f]/.test(parsed.value)) {
    return invalid(`${field} must be a safe Git revision and may not begin with '-'.`);
  }
  return parsed;
}

function readOptionalPath(
  input: Record<string, unknown>,
  field: string,
): { ok: true; value?: string } | { ok: false; message: string } {
  const parsed = readOptionalString(input, field, 2_000);
  if (!parsed.ok || !parsed.value) return parsed;
  const relative = requireResourceRelativePath(parsed.value, { field });
  if (!relative.ok) return invalid(relative.message);
  if (relative.relativePath.includes(":")) {
    return invalid(`${field} may not contain ':' in git_read.`);
  }
  return { ok: true, value: relative.relativePath };
}

function readOptionalInteger(
  input: Record<string, unknown>,
  field: string,
  maximum: number,
): { ok: true; value?: number } | { ok: false; message: string } {
  const value = input[field];
  if (value === undefined) return { ok: true };
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return invalid(`${field} must be an integer between 1 and ${maximum}.`);
  }
  return { ok: true, value: value as number };
}

function readOptionalBoolean(
  input: Record<string, unknown>,
  field: string,
): { ok: true; value?: boolean } | { ok: false; message: string } {
  const value = input[field];
  if (value === undefined) return { ok: true };
  return typeof value === "boolean"
    ? { ok: true, value }
    : invalid(`${field} must be a boolean.`);
}

function readOptionalDiffScope(
  input: Record<string, unknown>,
): { ok: true; value?: GitDiffScope } | { ok: false; message: string } {
  const value = input["diffScope"];
  if (value === undefined) return { ok: true };
  if (value !== "commits" && value !== "working" && value !== "staged") {
    return invalid("diffScope must be commits, working, or staged.");
  }
  return { ok: true, value };
}

function isGitReadOperation(value: string): value is GitReadOperation {
  return (GIT_READ_OPERATIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): { ok: false; message: string } {
  return { ok: false, message };
}
