import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolResult, ToolResultV2 } from "../../types.js";
import { resolveWorkspaceMutationPath } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, succeededContract, successV2 } from "../contract-helpers.js";
import { externalWorkspacePathError } from "./external-path-policy.js";
import { MAX_PATCH_FILES, MAX_PATCHES_PER_FILE, validatePatchFilesInput } from "./validators.js";
import type { PatchFilesPatch } from "./types.js";
import { buildTextTargetDiagnostic, type TextTargetDiagnostic } from "./target-diagnostics.js";
import {
  detectFileLineEnding,
  hasTrailingLineBreak,
  splitFileLines,
  splitFileLineSpans,
} from "./text-lines.js";

interface ResolvedPatchFile {
  requestedPath: string;
  filePath: string;
  patches: PatchFilesPatch[];
}

interface PatchCheck {
  patchIndex: number;
  kind: PatchFilesPatch["kind"];
  status: "passed";
  message: string;
  matchStrategy?: TextMatchStrategy;
}

type TextMatchStrategy =
  | "exact"
  | "line_ending"
  | "trim_end"
  | "trim"
  | "normalized_punctuation"
  | "whitespace_normalized";

interface TextMatch {
  start: number;
  end: number;
  strategy: TextMatchStrategy;
}

interface DraftPatchFile {
  requestedPath: string;
  filePath: string;
  originalContent: string;
  updatedContent: string;
  patchesApplied: number;
  changesApplied: number;
  checks: PatchCheck[];
}

interface PreparedPatchWrite {
  requestedPath: string;
  filePath: string;
  tempPath: string;
  content: string;
  patchesApplied: number;
  changesApplied: number;
  checks: PatchCheck[];
}

interface MovedPatchWrite {
  requestedPath: string;
  filePath: string;
  patchesApplied: number;
  changesApplied: number;
  bytesWritten: number;
  sha256: string;
  checks: PatchCheck[];
}

export const patchFilesTool: ToolDefinition = {
  name: "patch_files",
  description: "Patch one or more existing files using small stable targets. Prefer this for agent file edits over brittle full-block exact replacements.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: MAX_PATCH_FILES,
        description: `Files to patch. Use up to ${MAX_PATCH_FILES} files per call; split larger patches into another patch_files call.`,
        items: {
          type: "object",
          required: ["path", "patches"],
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the file to patch.",
            },
            patches: {
              type: "array",
              minItems: 1,
              maxItems: MAX_PATCHES_PER_FILE,
              items: {
                type: "object",
                required: ["kind"],
                properties: {
                  kind: {
                    type: "string",
                    enum: ["replace_text", "replace_all_text", "insert_before", "insert_after", "replace_lines"],
                  },
                  find: { type: "string", description: "Small stable text target for replace_text or replace_all_text." },
                  replace: { type: "string", description: "Replacement text for replace_text, replace_all_text, or replace_lines." },
                  anchor: { type: "string", description: "Exact anchor text for insert_before or insert_after." },
                  content: { type: "string", description: "Content to insert for insert_before or insert_after." },
                  startLine: { type: "integer", minimum: 1, description: "1-based start line for replace_lines." },
                  endLine: {
                    anyOf: [
                      { type: "integer", minimum: 1 },
                      { type: "string", enum: ["EOF"] },
                    ],
                    description: "1-based inclusive end line for replace_lines, or \"EOF\" to replace through the last file line.",
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["filesPatched", "patchesApplied", "changesApplied", "totalBytes", "files"],
    properties: {
      filesPatched: { type: "integer" },
      patchesApplied: { type: "integer" },
      changesApplied: { type: "integer" },
      totalBytes: { type: "integer" },
      files: {
        type: "array",
        items: {
          type: "object",
          required: ["requestedPath", "filePath", "patchesApplied", "changesApplied", "bytesWritten", "sha256", "checks"],
          properties: {
            requestedPath: { type: "string" },
            filePath: { type: "string" },
            patchesApplied: { type: "integer" },
            changesApplied: { type: "integer" },
            bytesWritten: { type: "integer" },
            sha256: { type: "string" },
            checks: { type: "array" },
          },
        },
      },
    },
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: false,
    mutatesWorkspace: true,
    idempotent: true,
    retrySafe: true,
  }),
  resultContract: succeededContract({
    assertions: [
      {
        id: "patched_paths_exist",
        kind: "all_paths_exist",
        path: "$.result.structuredContent.files[*].filePath",
      },
      {
        id: "patched_hashes_match",
        kind: "written_hashes_match",
        outputFilesPath: "$.result.structuredContent.files[*]",
      },
    ],
    artifacts: [{ kind: "file", path: "$.result.structuredContent.files[*].filePath" }],
    progressFacts: [{
      kind: "file_patched",
      path: "$.result.structuredContent.files[*].filePath",
      message: "File patched by patch_files.",
    }],
  }),
  errorContract: {
    codes: {
      PATCH_TARGET_NOT_FOUND: {
        category: "semantic",
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Use a smaller stable find string from the latest read output, use replace_lines, or rewrite the full file with write_files."],
      },
      PATCH_NO_CHANGE: {
        category: "semantic",
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Use a replacement that changes the file or skip this already-applied patch."],
      },
      PATCH_TARGET_AMBIGUOUS: {
        category: "semantic",
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Use a more specific find or anchor string, use replace_all_text intentionally, or use replace_lines from freshly read line numbers."],
      },
      PATCH_WRITE_FAILED: {
        category: "unknown",
        retryable: false,
        recoverable: true,
        suggestedNextActions: ["Inspect diagnostics and retry only after resolving the filesystem error."],
      },
    },
  },
  selectionHints: {
    tags: ["filesystem", "patch", "edit", "replace", "insert", "batch", "refactor"],
    aliases: ["apply_patches", "patch_in_files", "stable_patch_files", "modify_files"],
    examples: ["replace background: white with background: #f6f1e7", "patch two files with small stable targets"],
    domain: "filesystem",
    priority: 6,
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validatePatchFilesInput(input);
    if ("ok" in parsed) return parsed;

    const start = Date.now();
    const resolvedFiles: ResolvedPatchFile[] = [];
    for (const file of parsed.files) {
      const resolved = resolveWorkspaceMutationPath(file.path, {
        allowExternalPath: parsed.allowExternalPath,
        operation: "patch_files",
        root: context?.resourceScope?.rootPath,
      });
      if (!resolved.ok) return externalWorkspacePathError(resolved);
      resolvedFiles.push({
        requestedPath: file.path,
        filePath: resolved.path,
        patches: file.patches,
      });
    }

    const drafts: DraftPatchFile[] = [];
    for (const file of resolvedFiles) {
      let content: string;
      try {
        content = await readFile(file.filePath, "utf-8");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown filesystem read error";
        return patchError({
          code: "PATCH_TARGET_NOT_FOUND",
          message,
          start,
          file,
          category: "missing_path",
          suggestedFix: "Read or create the target file before retrying patch_files.",
        });
      }

      let updated = content;
      let changesApplied = 0;
      const checks: PatchCheck[] = [];
      for (const [patchIndex, patch] of file.patches.entries()) {
        const result = applyPatch(updated, patch, patchIndex);
        if (!result.ok) {
          return patchError({
            code: result.code,
            message: result.message,
            start,
            file,
            patchIndex,
            patch,
            expected: result.expected,
            actual: result.actual,
            diagnostic: result.diagnostic,
            suggestedFix: result.suggestedFix,
          });
        }
        updated = result.content;
        changesApplied += result.changesApplied;
        checks.push(...result.checks);
      }

      if (updated === content) {
        return patchError({
          code: "PATCH_NO_CHANGE",
          message: "Patches produced no file changes.",
          start,
          file,
          suggestedFix: "Use a replacement that changes the file or skip this already-applied patch.",
        });
      }

      drafts.push({
        requestedPath: file.requestedPath,
        filePath: file.filePath,
        originalContent: content,
        updatedContent: updated,
        patchesApplied: file.patches.length,
        changesApplied,
        checks,
      });
    }

    const prepared = drafts.map((draft): PreparedPatchWrite => ({
      requestedPath: draft.requestedPath,
      filePath: draft.filePath,
      tempPath: buildTempPath(draft.filePath),
      content: draft.updatedContent,
      patchesApplied: draft.patchesApplied,
      changesApplied: draft.changesApplied,
      checks: draft.checks,
    }));
    const tempPaths: string[] = [];
    const moved: MovedPatchWrite[] = [];

    try {
      for (const file of prepared) {
        await writeFile(file.tempPath, file.content, "utf-8");
        tempPaths.push(file.tempPath);
      }

      for (const file of prepared) {
        await rename(file.tempPath, file.filePath);
        const readBack = await readFile(file.filePath, "utf-8");
        const expectedHash = sha256Text(file.content);
        const actualHash = sha256Text(readBack);
        if (actualHash !== expectedHash) {
          throw new Error(`Read-back hash mismatch for ${file.filePath}`);
        }
        moved.push({
          requestedPath: file.requestedPath,
          filePath: file.filePath,
          patchesApplied: file.patchesApplied,
          changesApplied: file.changesApplied,
          bytesWritten: Buffer.byteLength(readBack, "utf-8"),
          sha256: actualHash,
          checks: file.checks,
        });
      }

      const patchesApplied = moved.reduce((sum, file) => sum + file.patchesApplied, 0);
      const changesApplied = moved.reduce((sum, file) => sum + file.changesApplied, 0);
      const totalBytes = moved.reduce((sum, file) => sum + file.bytesWritten, 0);
      const structuredContent = {
        filesPatched: moved.length,
        patchesApplied,
        changesApplied,
        totalBytes,
        files: moved,
      };
      const durationMs = Date.now() - start;
      return {
        ok: true,
        output: JSON.stringify(structuredContent, null, 2),
        meta: {
          durationMs,
          filesPatched: moved.length,
          patchesApplied,
          changesApplied,
          totalBytes,
          files: moved,
        },
        v2: successV2({
          code: "FILES_PATCHED",
          message: `Patched ${moved.length} file${moved.length === 1 ? "" : "s"} with ${patchesApplied} patch${patchesApplied === 1 ? "" : "es"}.`,
          structuredContent,
          artifacts: moved.map((file) => ({
            kind: "file",
            path: file.filePath,
            label: file.requestedPath,
            metadata: {
              patchesApplied: file.patchesApplied,
              changesApplied: file.changesApplied,
              bytesWritten: file.bytesWritten,
              sha256: file.sha256,
            },
          })),
          diagnostics: {
            durationMs,
            filesPatched: moved.length,
            patchesApplied,
            changesApplied,
            totalBytes,
          },
        }),
      };
    } catch (err) {
      await Promise.all(tempPaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
      const message = err instanceof Error ? err.message : "Unknown filesystem patch write error";
      const durationMs = Date.now() - start;
      return {
        ok: false,
        error: moved.length > 0
          ? `${message} (${moved.length}/${prepared.length} files were already moved into place)`
          : message,
        meta: {
          durationMs,
          filesRequested: prepared.length,
          filesPatched: moved.length,
          partial: moved.length > 0,
          files: moved,
        },
        v2: buildFailureResult(message, err, prepared, moved, durationMs),
      };
    }
  },
};

function applyPatch(
  content: string,
  patch: PatchFilesPatch,
  patchIndex: number,
): {
  ok: true;
  content: string;
  changesApplied: number;
  checks: PatchCheck[];
} | {
  ok: false;
  code: "PATCH_TARGET_NOT_FOUND" | "PATCH_TARGET_AMBIGUOUS" | "PATCH_NO_CHANGE";
  message: string;
  expected?: unknown;
  actual?: unknown;
  diagnostic?: TextTargetDiagnostic;
  suggestedFix: string;
} {
  switch (patch.kind) {
    case "replace_text":
    case "replace_all_text": {
      const find = patch.find ?? "";
      const replace = patch.replace ?? "";
      const matches = findTextMatches(content, find);
      if (matches.length === 0) {
        const diagnostic = buildTextTargetDiagnostic(content, find, "find text");
        return {
          ok: false,
          code: "PATCH_TARGET_NOT_FOUND",
          message: "find text not found in file.",
          expected: find,
          actual: diagnostic,
          diagnostic,
          suggestedFix: "Use a smaller stable target copied from the latest read output, for example just the property/value or identifier being changed.",
        };
      }
      const occurrenceCount = matches.length;
      if (patch.kind === "replace_text" && occurrenceCount > 1) {
        return {
          ok: false,
          code: "PATCH_TARGET_AMBIGUOUS",
          message: "find text matched more than one location.",
          expected: "exactly one match",
          actual: occurrenceCount,
          suggestedFix: "Use a more specific find string copied from the latest read output, or use replace_lines when the intended line is known.",
        };
      }
      const changesApplied = patch.kind === "replace_all_text" ? occurrenceCount : 1;
      const replacement = convertToLineEnding(replace, detectFileLineEnding(content));
      const updated = applyTextMatches(
        content,
        patch.kind === "replace_all_text" ? matches : matches.slice(0, 1),
        replacement,
      );
      if (updated === content) {
        return {
          ok: false,
          code: "PATCH_NO_CHANGE",
          message: "Patch produced no file changes.",
          expected: "file content changes",
          actual: "unchanged",
          suggestedFix: "Use a replacement that differs from the matched text.",
        };
      }
      const checks: PatchCheck[] = [{
        patchIndex,
        kind: patch.kind,
        status: "passed",
        message: matches[0]?.strategy === "exact"
          ? "Replacement text is present after patch."
          : `Replacement applied with ${matches[0]?.strategy ?? "tolerant"} matching.`,
        ...(matches[0] ? { matchStrategy: matches[0].strategy } : {}),
      }];
      if (patch.kind === "replace_all_text" && find !== replace && !replace.includes(find) && matches.every((match) => match.strategy === "exact")) {
        checks.push({
          patchIndex,
          kind: patch.kind,
          status: "passed",
          message: "Original find text is absent after replace_all_text.",
        });
      }
      return { ok: true, content: updated, changesApplied, checks };
    }
    case "insert_before":
    case "insert_after": {
      const anchor = patch.anchor ?? "";
      const insert = patch.content ?? "";
      const matches = findTextMatches(content, anchor);
      if (matches.length === 0) {
        const diagnostic = buildTextTargetDiagnostic(content, anchor, "anchor text");
        return {
          ok: false,
          code: "PATCH_TARGET_NOT_FOUND",
          message: "anchor text not found in file.",
          expected: anchor,
          actual: diagnostic,
          diagnostic,
          suggestedFix: "Use an anchor copied exactly from the latest read output or use replace_lines.",
        };
      }
      const occurrenceCount = matches.length;
      if (occurrenceCount > 1) {
        return {
          ok: false,
          code: "PATCH_TARGET_AMBIGUOUS",
          message: "anchor text matched more than one location.",
          expected: "exactly one match",
          actual: occurrenceCount,
          suggestedFix: "Use a more specific anchor copied from the latest read output, or use replace_lines when the intended line is known.",
        };
      }
      const match = matches[0]!;
      const normalizedInsert = convertToLineEnding(insert, detectFileLineEnding(content));
      const offset = patch.kind === "insert_before" ? match.start : match.end;
      return {
        ok: true,
        content: `${content.slice(0, offset)}${normalizedInsert}${content.slice(offset)}`,
        changesApplied: 1,
        checks: [{
          patchIndex,
          kind: patch.kind,
          status: "passed",
          message: match.strategy === "exact"
            ? "Inserted content is present after patch."
            : `Inserted content using ${match.strategy} anchor matching.`,
          matchStrategy: match.strategy,
        }],
      };
    }
    case "replace_lines":
      return replaceLines(content, patch, patchIndex);
  }
}

function findTextMatches(content: string, search: string): TextMatch[] {
  const exact = findExactMatches(content, search, "exact");
  if (exact.length > 0) return exact;

  const newlineAdjusted = convertToLineEnding(search, detectFileLineEnding(content));
  if (newlineAdjusted !== search) {
    const newlineMatches = findExactMatches(content, newlineAdjusted, "line_ending");
    if (newlineMatches.length > 0) return newlineMatches;
  }

  const trimEndMatches = findLineSequenceMatches(content, search, (value) => value.trimEnd(), "trim_end");
  if (trimEndMatches.length > 0) return trimEndMatches;

  const trimMatches = findLineSequenceMatches(content, search, (value) => value.trim(), "trim");
  if (trimMatches.length > 0) return trimMatches;

  const normalizedPunctuationMatches = findMappedMatches(
    content,
    normalizePunctuationWithMap,
    normalizePunctuation(search),
    "normalized_punctuation",
  );
  if (normalizedPunctuationMatches.length > 0) return normalizedPunctuationMatches;

  return findMappedMatches(
    content,
    normalizeWhitespaceWithMap,
    normalizeWhitespace(search),
    "whitespace_normalized",
  );
}

function findExactMatches(content: string, search: string, strategy: TextMatchStrategy): TextMatch[] {
  const matches: TextMatch[] = [];
  if (search.length === 0) return matches;

  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(search, offset);
    if (index === -1) break;
    matches.push({ start: index, end: index + search.length, strategy });
    offset = index + search.length;
  }
  return matches;
}

function findLineSequenceMatches(
  content: string,
  search: string,
  normalize: (value: string) => string,
  strategy: TextMatchStrategy,
): TextMatch[] {
  const contentLines = splitFileLineSpans(content);
  const searchLines = splitFileLines(search);
  if (searchLines.length === 0 || searchLines.length > contentLines.length) return [];

  const normalizedSearch = searchLines.map(normalize);
  const matches: TextMatch[] = [];
  for (let startLine = 0; startLine <= contentLines.length - normalizedSearch.length; startLine += 1) {
    let matched = true;
    for (let offset = 0; offset < normalizedSearch.length; offset += 1) {
      if (normalize(contentLines[startLine + offset]!.text) !== normalizedSearch[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const first = contentLines[startLine]!;
      const last = contentLines[startLine + normalizedSearch.length - 1]!;
      matches.push({ start: first.start, end: last.end, strategy });
    }
  }
  return matches;
}

function findMappedMatches(
  content: string,
  contentMapper: (value: string) => { text: string; map: number[] },
  normalizedSearch: string,
  strategy: TextMatchStrategy,
): TextMatch[] {
  const haystack = contentMapper(content);
  const needle = normalizedSearch;
  const matches: TextMatch[] = [];
  if (needle.length === 0) return matches;

  let offset = 0;
  while (offset <= haystack.text.length) {
    const index = haystack.text.indexOf(needle, offset);
    if (index === -1) break;
    const start = haystack.map[index];
    const endSource = haystack.map[index + needle.length - 1];
    if (start !== undefined && endSource !== undefined) {
      matches.push({ start, end: endSource + 1, strategy });
    }
    offset = index + needle.length;
  }
  return matches;
}

function applyTextMatches(content: string, matches: TextMatch[], replacement: string): string {
  let updated = content;
  for (const match of [...matches].reverse()) {
    updated = `${updated.slice(0, match.start)}${replacement}${updated.slice(match.end)}`;
  }
  return updated;
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return ending === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

function normalizeWhitespace(value: string): string {
  return normalizePunctuation(value).replace(/\s+/g, " ").trim();
}

function normalizeWhitespaceWithMap(value: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let pendingSpaceIndex: number | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = normalizePunctuationChar(value[index]!);
    if (/\s/.test(char)) {
      if (text.length > 0) pendingSpaceIndex ??= index;
      continue;
    }
    if (pendingSpaceIndex !== undefined && text.length > 0) {
      text += " ";
      map.push(pendingSpaceIndex);
    }
    pendingSpaceIndex = undefined;
    text += char;
    map.push(index);
  }

  return { text: text.trim(), map };
}

function normalizePunctuationWithMap(value: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const normalized = normalizePunctuationChar(value[index]!);
    text += normalized;
    for (let offset = 0; offset < normalized.length; offset += 1) {
      map.push(index);
    }
  }
  return { text, map };
}

function normalizePunctuation(value: string): string {
  return Array.from(value).map(normalizePunctuationChar).join("");
}

function normalizePunctuationChar(value: string): string {
  switch (value) {
    case "\u2018":
    case "\u2019":
    case "\u201A":
    case "\u201B":
      return "'";
    case "\u201C":
    case "\u201D":
    case "\u201E":
    case "\u201F":
      return "\"";
    case "\u2010":
    case "\u2011":
    case "\u2012":
    case "\u2013":
    case "\u2014":
    case "\u2015":
    case "\u2212":
      return "-";
    case "\u00A0":
    case "\u2002":
    case "\u2003":
    case "\u2004":
    case "\u2005":
    case "\u2006":
    case "\u2007":
    case "\u2008":
    case "\u2009":
    case "\u200A":
    case "\u202F":
    case "\u205F":
    case "\u3000":
      return " ";
    case "\u2026":
      return "...";
    default:
      return value;
  }
}

function replaceLines(
  content: string,
  patch: PatchFilesPatch,
  patchIndex: number,
): ReturnType<typeof applyPatch> {
  const startLine = patch.startLine ?? 0;
  const replacement = patch.replace ?? "";
  const newline = detectFileLineEnding(content);
  const hasFinalLineBreak = hasTrailingLineBreak(content);
  const lines = splitFileLines(content);
  const endLine = patch.endLine === "EOF" ? lines.length : patch.endLine ?? 0;
  const requestedEndLine = patch.endLine ?? 0;

  if (startLine > lines.length || endLine > lines.length) {
    return {
      ok: false,
      code: "PATCH_TARGET_NOT_FOUND",
      message: `line range ${startLine}-${String(requestedEndLine)} is outside file line count ${lines.length}.`,
      expected: { startLine, endLine: requestedEndLine },
      actual: { lineCount: lines.length },
      suggestedFix: "Read the latest exact line range, then retry replace_lines with valid 1-based lines or endLine=\"EOF\".",
    };
  }

  if (endLine < startLine) {
    return {
      ok: false,
      code: "PATCH_TARGET_NOT_FOUND",
      message: `line range ${startLine}-${String(requestedEndLine)} is invalid for file line count ${lines.length}.`,
      expected: { startLine, endLine: requestedEndLine },
      actual: { lineCount: lines.length, resolvedEndLine: endLine },
      suggestedFix: "Use an endLine greater than or equal to startLine, or use endLine=\"EOF\" when replacing through the end of the file.",
    };
  }

  const replacementLines = replacement.length === 0 ? [] : splitFileLines(replacement);
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
  const updated = `${lines.join(newline)}${hasFinalLineBreak ? newline : ""}`;
  if (updated === content) {
    return {
      ok: false,
      code: "PATCH_NO_CHANGE",
      message: "Line replacement produced no file changes.",
      expected: "file content changes",
      actual: "unchanged",
      suggestedFix: "Use replacement lines that differ from the current line range.",
    };
  }
  return {
    ok: true,
    content: updated,
    changesApplied: 1,
    checks: [{
      patchIndex,
      kind: patch.kind,
      status: "passed",
      message: patch.endLine === "EOF"
        ? "Replacement through EOF was applied."
        : replacement.length > 0 ? "Replacement lines are present after patch." : "Line range was removed.",
    }],
  };
}

function patchError(input: {
  code: "PATCH_TARGET_NOT_FOUND" | "PATCH_TARGET_AMBIGUOUS" | "PATCH_NO_CHANGE";
  message: string;
  start: number;
  file: Pick<ResolvedPatchFile, "requestedPath" | "filePath">;
  patchIndex?: number;
  patch?: PatchFilesPatch;
  category?: "semantic" | "missing_path";
  expected?: unknown;
  actual?: unknown;
  diagnostic?: TextTargetDiagnostic;
  suggestedFix: string;
}): ToolResult {
  const diagnostic = input.diagnostic ?? (isTextTargetDiagnostic(input.actual) ? input.actual : undefined);
  return errorResult({
    code: input.code,
    message: input.message,
    category: input.category ?? "semantic",
    target: input.file.filePath,
    expected: input.expected,
    actual: input.actual,
    retryable: true,
    recoverable: true,
    suggestedNextActions: [
      input.suggestedFix,
      "Use write_files if replacing the complete file is clearer than patching.",
    ],
    structuredContent: {
      requestedPath: input.file.requestedPath,
      filePath: input.file.filePath,
      ...(input.patchIndex !== undefined ? { patchIndex: input.patchIndex } : {}),
      ...(input.patch ? { kind: input.patch.kind } : {}),
      suggestedFix: input.suggestedFix,
      ...(diagnostic ? { diagnostic } : {}),
    },
    meta: {
      durationMs: Date.now() - input.start,
      filePath: input.file.filePath,
      ...(input.patchIndex !== undefined ? { patchIndex: input.patchIndex } : {}),
      ...(input.patch ? { kind: input.patch.kind } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    },
  });
}

function isTextTargetDiagnostic(value: unknown): value is TextTargetDiagnostic {
  return Boolean(value && typeof value === "object" && "targetKind" in value && "hint" in value);
}

function buildFailureResult(
  message: string,
  err: unknown,
  prepared: PreparedPatchWrite[],
  moved: MovedPatchWrite[],
  durationMs: number,
): ToolResultV2 {
  const errno = err as NodeJS.ErrnoException;
  return {
    transportOk: true,
    operationStatus: moved.length > 0 ? "partial" : "failed",
    code: "PATCH_WRITE_FAILED",
    message: moved.length > 0
      ? `${message} (${moved.length}/${prepared.length} files were already moved into place)`
      : message,
    structuredContent: {
      filesRequested: prepared.length,
      filesPatched: moved.length,
      partial: moved.length > 0,
      files: moved,
    },
    artifacts: moved.map((file) => ({
      kind: "file",
      path: file.filePath,
      label: file.requestedPath,
      metadata: {
        patchesApplied: file.patchesApplied,
        changesApplied: file.changesApplied,
        bytesWritten: file.bytesWritten,
        sha256: file.sha256,
      },
    })),
    error: {
      category: "unknown",
      code: "PATCH_WRITE_FAILED",
      message,
      retryable: false,
      recoverable: true,
      ...(typeof errno.path === "string" ? { target: errno.path } : {}),
      suggestedNextActions: ["Inspect diagnostics and retry only after resolving the filesystem error."],
    },
    diagnostics: {
      durationMs,
      filesRequested: prepared.length,
      filesPatched: moved.length,
      partial: moved.length > 0,
      errnoCode: errno.code,
    },
  };
}

function buildTempPath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}
