import type { ToolResult } from "../../types.js";
import type {
  ReadFileInput,
  ReadFilesInput,
  ReadFilesInputFile,
  WriteFileInput,
  WriteFilesInput,
  WriteFilesInputFile,
  EditFileInput,
  DeleteInput,
  ListDirectoryInput,
  CreateDirectoryInput,
  MoveInput,
  FindFilesInput,
  SearchInFilesInput,
} from "./types.js";

const MAX_READ_FILES = 20;

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

function isNonNegativeInt(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 && Number.isInteger(val);
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
  if (
    v.mode !== undefined
    && v.mode !== "auto"
    && v.mode !== "profile"
    && v.mode !== "search"
    && v.mode !== "slice"
    && v.mode !== "full"
  ) {
    return fail("mode must be one of auto, profile, search, slice, or full.");
  }
  if (v.query !== undefined && typeof v.query !== "string") {
    return fail("query must be a string when provided.");
  }
  if (v.startLine !== undefined && !isNonNegativeInt(v.startLine)) {
    return fail("startLine must be a non-negative integer.");
  }
  if (v.lineCount !== undefined && !isPositiveInt(v.lineCount)) {
    return fail("lineCount must be a positive integer.");
  }
  if (v.contextLines !== undefined && !isNonNegativeInt(v.contextLines)) {
    return fail("contextLines must be a non-negative integer.");
  }
  if (v.maxBlocks !== undefined && !isPositiveInt(v.maxBlocks)) {
    return fail("maxBlocks must be a positive integer.");
  }
  return {
    path: v.path,
    mode: v.mode,
    query: v.query,
    startLine: v.startLine,
    lineCount: v.lineCount,
    contextLines: v.contextLines,
    maxBlocks: v.maxBlocks,
  };
}

export function validateReadFilesInput(input: unknown): ReadFilesInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<ReadFilesInput>;
  if (!Array.isArray(v.files) || v.files.length === 0) {
    return fail("files must be a non-empty array.");
  }
  if (v.files.length > MAX_READ_FILES) {
    return fail(`files must contain at most ${MAX_READ_FILES} entries.`);
  }

  const files: ReadFilesInputFile[] = [];
  for (const [index, file] of v.files.entries()) {
    if (!isObject(file)) return fail(`files[${index}] must be an object.`);
    const parsed = validateReadFileInput(file);
    if ("ok" in parsed) {
      const detail = parsed.error?.replace(/^Invalid input:\s*/, "") ?? "invalid read input.";
      return fail(`files[${index}]: ${detail}`);
    }
    files.push(parsed);
  }

  if (v.maxPerFileChars !== undefined && !isPositiveInt(v.maxPerFileChars)) {
    return fail("maxPerFileChars must be a positive integer.");
  }
  if (v.maxTotalChars !== undefined && !isPositiveInt(v.maxTotalChars)) {
    return fail("maxTotalChars must be a positive integer.");
  }
  if (v.allowMissing !== undefined && typeof v.allowMissing !== "boolean") {
    return fail("allowMissing must be a boolean.");
  }

  return {
    files,
    maxPerFileChars: v.maxPerFileChars,
    maxTotalChars: v.maxTotalChars,
    allowMissing: v.allowMissing,
  };
}

export function validateWriteFileInput(input: unknown): WriteFileInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<WriteFileInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  if (typeof v.content !== "string") return fail("content must be a string.");
  if (v.createDirs !== undefined && typeof v.createDirs !== "boolean") {
    return fail("createDirs must be a boolean.");
  }
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    path: v.path,
    content: v.content,
    createDirs: v.createDirs,
    allowExternalPath: v.allowExternalPath,
    confirmationToken: v.confirmationToken,
  };
}

export function validateWriteFilesInput(input: unknown): WriteFilesInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<WriteFilesInput>;
  if (!Array.isArray(v.files) || v.files.length === 0) {
    return fail("files must be a non-empty array.");
  }
  const files: WriteFilesInputFile[] = [];
  for (const [index, file] of v.files.entries()) {
    if (!isObject(file)) return fail(`files[${index}] must be an object.`);
    const candidate = file as Partial<WriteFilesInputFile>;
    if (!isNonEmptyString(candidate.path)) return fail(`files[${index}].path must be a non-empty string.`);
    if (typeof candidate.content !== "string") return fail(`files[${index}].content must be a string.`);
    files.push({ path: candidate.path, content: candidate.content });
  }
  if (v.createDirs !== undefined && typeof v.createDirs !== "boolean") {
    return fail("createDirs must be a boolean.");
  }
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    files,
    createDirs: v.createDirs,
    allowExternalPath: v.allowExternalPath,
    confirmationToken: v.confirmationToken,
  };
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
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    path: v.path,
    oldString: v.oldString,
    newString: v.newString,
    replaceAll: v.replaceAll,
    allowExternalPath: v.allowExternalPath,
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
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    path: v.path,
    recursive: v.recursive,
    allowExternalPath: v.allowExternalPath,
    confirmationToken: v.confirmationToken,
  };
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
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    path: v.path,
    recursive: v.recursive ?? true,
    allowExternalPath: v.allowExternalPath,
    confirmationToken: v.confirmationToken,
  };
}

export function validateMoveInput(input: unknown): MoveInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<MoveInput>;
  if (!isNonEmptyString(v.source)) return fail("source must be a non-empty string.");
  if (!isNonEmptyString(v.destination)) return fail("destination must be a non-empty string.");
  if (v.overwrite !== undefined && typeof v.overwrite !== "boolean") {
    return fail("overwrite must be a boolean.");
  }
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    source: v.source,
    destination: v.destination,
    overwrite: v.overwrite,
    allowExternalPath: v.allowExternalPath,
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
  if (v.contextLines !== undefined && !isNonNegativeInt(v.contextLines)) {
    return fail("contextLines must be a non-negative integer.");
  }

  return { ...base, caseSensitive: v.caseSensitive, contextLines: v.contextLines };
}
