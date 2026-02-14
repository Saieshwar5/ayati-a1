import type { ToolResult } from "../../types.js";
import type {
  ReadFileInput,
  WriteFileInput,
  EditFileInput,
  DeleteInput,
  ListDirectoryInput,
  CreateDirectoryInput,
  MoveInput,
  FindFilesInput,
  SearchInFilesInput,
} from "./types.js";

function fail(msg: string): ToolResult {
  return { ok: false, error: `Invalid input: ${msg}` };
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

function isPositiveInt(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val > 0 && Number.isInteger(val);
}

function validateConfirmationToken(token: unknown): ToolResult | null {
  if (token === undefined) return null;
  if (typeof token !== "string") return fail("confirmationToken must be a string.");
  return null;
}

export function validateReadFileInput(input: unknown): ReadFileInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<ReadFileInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  if (v.offset !== undefined && (!Number.isFinite(v.offset) || v.offset < 0)) {
    return fail("offset must be a non-negative number.");
  }
  if (v.limit !== undefined && !isPositiveInt(v.limit)) {
    return fail("limit must be a positive integer.");
  }
  return { path: v.path, offset: v.offset, limit: v.limit };
}

export function validateWriteFileInput(input: unknown): WriteFileInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<WriteFileInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  if (typeof v.content !== "string") return fail("content must be a string.");
  if (v.createDirs !== undefined && typeof v.createDirs !== "boolean") {
    return fail("createDirs must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return { path: v.path, content: v.content, createDirs: v.createDirs, confirmationToken: v.confirmationToken };
}

export function validateEditFileInput(input: unknown): EditFileInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<EditFileInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  if (typeof v.oldString !== "string" || v.oldString.length === 0) {
    return fail("oldString must be a non-empty string.");
  }
  if (typeof v.newString !== "string") return fail("newString must be a string.");
  if (v.replaceAll !== undefined && typeof v.replaceAll !== "boolean") {
    return fail("replaceAll must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    path: v.path,
    oldString: v.oldString,
    newString: v.newString,
    replaceAll: v.replaceAll,
    confirmationToken: v.confirmationToken,
  };
}

export function validateDeleteInput(input: unknown): DeleteInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<DeleteInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  if (v.recursive !== undefined && typeof v.recursive !== "boolean") {
    return fail("recursive must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return { path: v.path, recursive: v.recursive, confirmationToken: v.confirmationToken };
}

export function validateListDirectoryInput(input: unknown): ListDirectoryInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<ListDirectoryInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  if (v.recursive !== undefined && typeof v.recursive !== "boolean") {
    return fail("recursive must be a boolean.");
  }
  if (v.showHidden !== undefined && typeof v.showHidden !== "boolean") {
    return fail("showHidden must be a boolean.");
  }
  return { path: v.path, recursive: v.recursive, showHidden: v.showHidden };
}

export function validateCreateDirectoryInput(input: unknown): CreateDirectoryInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<CreateDirectoryInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  if (v.recursive !== undefined && typeof v.recursive !== "boolean") {
    return fail("recursive must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return { path: v.path, recursive: v.recursive ?? true, confirmationToken: v.confirmationToken };
}

export function validateMoveInput(input: unknown): MoveInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<MoveInput>;
  if (!isNonEmptyString(v.source)) return fail("source must be a non-empty string.");
  if (!isNonEmptyString(v.destination)) return fail("destination must be a non-empty string.");
  if (v.overwrite !== undefined && typeof v.overwrite !== "boolean") {
    return fail("overwrite must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    source: v.source,
    destination: v.destination,
    overwrite: v.overwrite,
    confirmationToken: v.confirmationToken,
  };
}

function validateSearchCommon(
  input: unknown,
): {
  query: string;
  roots?: string[];
  maxDepth?: number;
  maxResults?: number;
  includeHidden?: boolean;
} | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<FindFilesInput>;
  if (!isNonEmptyString(v.query)) return fail("query must be a non-empty string.");
  if (v.roots !== undefined) {
    if (!Array.isArray(v.roots) || !v.roots.every((root) => isNonEmptyString(root))) {
      return fail("roots must be an array of non-empty strings.");
    }
  }
  if (v.maxDepth !== undefined && !isPositiveInt(v.maxDepth)) {
    return fail("maxDepth must be a positive integer.");
  }
  if (v.maxResults !== undefined && !isPositiveInt(v.maxResults)) {
    return fail("maxResults must be a positive integer.");
  }
  if (v.includeHidden !== undefined && typeof v.includeHidden !== "boolean") {
    return fail("includeHidden must be a boolean.");
  }
  return {
    query: v.query,
    roots: v.roots,
    maxDepth: v.maxDepth,
    maxResults: v.maxResults,
    includeHidden: v.includeHidden,
  };
}

export function validateFindFilesInput(input: unknown): FindFilesInput | ToolResult {
  return validateSearchCommon(input);
}

export function validateSearchInFilesInput(input: unknown): SearchInFilesInput | ToolResult {
  const base = validateSearchCommon(input);
  if ("ok" in base) return base;

  const v = input as Partial<SearchInFilesInput>;
  if (v.caseSensitive !== undefined && typeof v.caseSensitive !== "boolean") {
    return fail("caseSensitive must be a boolean.");
  }

  return { ...base, caseSensitive: v.caseSensitive };
}
