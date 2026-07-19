import type { ToolResult } from "../../types.js";
import { requireAbsolutePath } from "../../workspace-paths.js";
import type {
  ReadFileInput,
  ReadFilesInput,
  ReadFilesInputFile,
  InspectPathsInput,
  WriteFilesInput,
  WriteFilesInputFile,
  PatchFilesInput,
  PatchFilesInputFile,
  PatchFilesPatch,
  PatchFilesPatchKind,
  DeleteInput,
  ListDirectoryInput,
  CreateDirectoryInput,
  MoveInput,
  FindFilesInput,
  SearchInFilesInput,
} from "./types.js";

export const MAX_READ_FILES = 4;
export const MAX_WRITE_FILES = 2;
export const MAX_PATCH_FILES = 2;
export const MAX_PATCHES_PER_FILE = 20;

function fail(msg: string): ToolResult {
  return { ok: false, error: `Invalid input: ${msg}` };
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
        suggestedNextActions: ["Use the absolute locator of the relevant bound filesystem resource and retry."],
      },
    },
  };
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

function isSha256String(val: unknown): val is string {
  return typeof val === "string" && /^[a-f0-9]{64}$/i.test(val);
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
  const path = absolutePath(v.path, "path");
  if (typeof path !== "string") return path;
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
    path,
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
    return fail(`files must contain at most ${MAX_READ_FILES} entries; split larger reads into multiple read_files calls.`);
  }

  const files: ReadFilesInputFile[] = [];
  for (const [index, file] of v.files.entries()) {
    if (!isObject(file)) return fail(`files[${index}] must be an object.`);
    const parsed = validateReadFileInput(file);
    if ("ok" in parsed) {
      if (parsed.v2?.code === "ABSOLUTE_PATH_REQUIRED") return parsed;
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

export function validateInspectPathsInput(input: unknown): InspectPathsInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<InspectPathsInput>;
  if (!Array.isArray(v.paths) || v.paths.length === 0) {
    return fail("paths must be a non-empty array.");
  }
  if (!v.paths.every((path) => isNonEmptyString(path))) {
    return fail("paths must contain only non-empty strings.");
  }
  const paths: string[] = [];
  for (const [index, value] of v.paths.entries()) {
    const path = absolutePath(value, `paths[${index}]`);
    if (typeof path !== "string") return path;
    paths.push(path);
  }
  if (v.includeLineCount !== undefined && typeof v.includeLineCount !== "boolean") {
    return fail("includeLineCount must be a boolean.");
  }
  if (v.includeHash !== undefined && typeof v.includeHash !== "boolean") {
    return fail("includeHash must be a boolean.");
  }
  if (v.includeDirectoryCounts !== undefined && typeof v.includeDirectoryCounts !== "boolean") {
    return fail("includeDirectoryCounts must be a boolean.");
  }
  return {
    paths,
    includeLineCount: v.includeLineCount,
    includeHash: v.includeHash,
    includeDirectoryCounts: v.includeDirectoryCounts,
  };
}

export function validateWriteFilesInput(input: unknown): WriteFilesInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<WriteFilesInput>;
  if (!Array.isArray(v.files) || v.files.length === 0) {
    return fail("files must be a non-empty array.");
  }
  if (v.files.length > MAX_WRITE_FILES) {
    return fail(`files must contain at most ${MAX_WRITE_FILES} entries; split larger writes into multiple write_files calls.`);
  }
  const files: WriteFilesInputFile[] = [];
  for (const [index, file] of v.files.entries()) {
    if (!isObject(file)) return fail(`files[${index}] must be an object.`);
    const candidate = file as Partial<WriteFilesInputFile>;
    if (!isNonEmptyString(candidate.path)) return fail(`files[${index}].path must be a non-empty string.`);
    const path = absolutePath(candidate.path, `files[${index}].path`);
    if (typeof path !== "string") return path;
    if (typeof candidate.content !== "string") return fail(`files[${index}].content must be a string.`);
    if (candidate.baseSha256 !== undefined && !isSha256String(candidate.baseSha256)) {
      return fail(`files[${index}].baseSha256 must be a 64-character sha256 hex string when provided.`);
    }
    files.push({
      path,
      content: candidate.content,
      baseSha256: candidate.baseSha256?.toLowerCase(),
    });
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

export function validatePatchFilesInput(input: unknown): PatchFilesInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<PatchFilesInput>;
  if (!Array.isArray(v.files)) return fail("files must be an array.");
  if (v.files.length === 0) return fail("files must contain at least one file.");
  if (v.files.length > MAX_PATCH_FILES) {
    return fail(`files must contain at most ${MAX_PATCH_FILES} entries; split larger patches into multiple patch_files calls.`);
  }
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;

  const files: PatchFilesInputFile[] = [];
  for (const [fileIndex, rawFile] of v.files.entries()) {
    if (!isObject(rawFile)) return fail(`files[${fileIndex}] must be an object.`);
    const file = rawFile as Partial<PatchFilesInputFile>;
    if (!isNonEmptyString(file.path)) return fail(`files[${fileIndex}].path must be a non-empty string.`);
    const path = absolutePath(file.path, `files[${fileIndex}].path`);
    if (typeof path !== "string") return path;
    if (!Array.isArray(file.patches)) return fail(`files[${fileIndex}].patches must be an array.`);
    if (file.patches.length === 0) return fail(`files[${fileIndex}].patches must contain at least one patch.`);
    if (file.patches.length > MAX_PATCHES_PER_FILE) {
      return fail(`files[${fileIndex}].patches must contain ${MAX_PATCHES_PER_FILE} or fewer patches.`);
    }

    const patches: PatchFilesPatch[] = [];
    for (const [patchIndex, rawPatch] of file.patches.entries()) {
      if (!isObject(rawPatch)) return fail(`files[${fileIndex}].patches[${patchIndex}] must be an object.`);
      const patch = rawPatch as Partial<PatchFilesPatch>;
      if (!isPatchFilesPatchKind(patch.kind)) {
        return fail(`files[${fileIndex}].patches[${patchIndex}].kind must be one of replace_text, replace_all_text, insert_before, insert_after, or replace_lines.`);
      }
      if (patch.kind === "replace_text" || patch.kind === "replace_all_text") {
        if (typeof patch.find !== "string" || patch.find.length === 0) {
          return fail(`files[${fileIndex}].patches[${patchIndex}].find must be a non-empty string for ${patch.kind}.`);
        }
        if (typeof patch.replace !== "string") {
          return fail(`files[${fileIndex}].patches[${patchIndex}].replace must be a string for ${patch.kind}.`);
        }
      } else if (patch.kind === "insert_before" || patch.kind === "insert_after") {
        if (typeof patch.anchor !== "string" || patch.anchor.length === 0) {
          return fail(`files[${fileIndex}].patches[${patchIndex}].anchor must be a non-empty string for ${patch.kind}.`);
        }
        if (typeof patch.content !== "string" || patch.content.length === 0) {
          return fail(`files[${fileIndex}].patches[${patchIndex}].content must be a non-empty string for ${patch.kind}.`);
        }
      } else {
        if (!isPositiveInt(patch.startLine)) {
          return fail(`files[${fileIndex}].patches[${patchIndex}].startLine must be a positive integer for replace_lines.`);
        }
        if (!isPositiveInt(patch.endLine) && patch.endLine !== "EOF") {
          return fail(`files[${fileIndex}].patches[${patchIndex}].endLine must be a positive integer or "EOF" for replace_lines.`);
        }
        if (typeof patch.endLine === "number" && patch.endLine < patch.startLine) {
          return fail(`files[${fileIndex}].patches[${patchIndex}].endLine must be greater than or equal to startLine.`);
        }
        if (typeof patch.replace !== "string") {
          return fail(`files[${fileIndex}].patches[${patchIndex}].replace must be a string for replace_lines.`);
        }
      }
      patches.push({
        kind: patch.kind,
        ...(patch.find !== undefined ? { find: patch.find } : {}),
        ...(patch.replace !== undefined ? { replace: patch.replace } : {}),
        ...(patch.anchor !== undefined ? { anchor: patch.anchor } : {}),
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.startLine !== undefined ? { startLine: patch.startLine } : {}),
        ...(patch.endLine !== undefined ? { endLine: patch.endLine } : {}),
      });
    }
    files.push({ path, patches });
  }

  return {
    files,
    allowExternalPath: v.allowExternalPath,
    confirmationToken: v.confirmationToken,
  };
}

function isPatchFilesPatchKind(value: unknown): value is PatchFilesPatchKind {
  return value === "replace_text"
    || value === "replace_all_text"
    || value === "insert_before"
    || value === "insert_after"
    || value === "replace_lines";
}

export function validateDeleteInput(input: unknown): DeleteInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<DeleteInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  const path = absolutePath(v.path, "path");
  if (typeof path !== "string") return path;
  if (v.recursive !== undefined && typeof v.recursive !== "boolean") {
    return fail("recursive must be a boolean.");
  }
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    path,
    recursive: v.recursive,
    allowExternalPath: v.allowExternalPath,
    confirmationToken: v.confirmationToken,
  };
}

export function validateListDirectoryInput(input: unknown): ListDirectoryInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<ListDirectoryInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  const path = absolutePath(v.path, "path");
  if (typeof path !== "string") return path;
  if (v.recursive !== undefined && typeof v.recursive !== "boolean") {
    return fail("recursive must be a boolean.");
  }
  if (v.showHidden !== undefined && typeof v.showHidden !== "boolean") {
    return fail("showHidden must be a boolean.");
  }
  return { path, recursive: v.recursive, showHidden: v.showHidden };
}

export function validateCreateDirectoryInput(input: unknown): CreateDirectoryInput | ToolResult {
  if (!isObject(input)) return fail("expected object.");
  const v = input as Partial<CreateDirectoryInput>;
  if (!isNonEmptyString(v.path)) return fail("path must be a non-empty string.");
  const path = absolutePath(v.path, "path");
  if (typeof path !== "string") return path;
  if (v.recursive !== undefined && typeof v.recursive !== "boolean") {
    return fail("recursive must be a boolean.");
  }
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    path,
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
  const source = absolutePath(v.source, "source");
  if (typeof source !== "string") return source;
  const destination = absolutePath(v.destination, "destination");
  if (typeof destination !== "string") return destination;
  if (v.overwrite !== undefined && typeof v.overwrite !== "boolean") {
    return fail("overwrite must be a boolean.");
  }
  if (v.allowExternalPath !== undefined && typeof v.allowExternalPath !== "boolean") {
    return fail("allowExternalPath must be a boolean.");
  }
  const tokenErr = validateConfirmationToken(v.confirmationToken);
  if (tokenErr) return tokenErr;
  return {
    source,
    destination,
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
  const roots: string[] | undefined = v.roots
    ? []
    : undefined;
  for (const [index, value] of (v.roots ?? []).entries()) {
    const root = absolutePath(value, `roots[${index}]`);
    if (typeof root !== "string") return root;
    roots!.push(root);
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
    roots,
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
