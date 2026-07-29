import type { PatchFilesPatch } from "./types.js";
import {
  detectFileLineEnding,
  hasTrailingLineBreak,
  splitFileLines,
} from "./text-lines.js";
import {
  buildTextTargetDiagnostic,
  type TextTargetDiagnostic,
} from "./target-diagnostics.js";

export type PatchFailureCode =
  | "PATCH_TARGET_NOT_FOUND"
  | "PATCH_TARGET_AMBIGUOUS"
  | "PATCH_NO_CHANGE";

export type TextMatchStrategy = "exact" | "line_ending";

export interface PatchCheck {
  patchIndex: number;
  kind: PatchFilesPatch["kind"];
  status: "passed";
  message: string;
  matchStrategy?: TextMatchStrategy;
}

export interface AppliedPatches {
  ok: true;
  content: string;
  patchesApplied: number;
  changesApplied: number;
  checks: PatchCheck[];
}

export interface PatchApplicationFailure {
  ok: false;
  code: PatchFailureCode;
  message: string;
  patchIndex?: number;
  kind?: PatchFilesPatch["kind"];
  expected?: unknown;
  actual?: unknown;
  diagnostic?: TextTargetDiagnostic;
  suggestedFix: string;
}

export type ApplyPatchesResult = AppliedPatches | PatchApplicationFailure;

interface TextMatch {
  start: number;
  end: number;
  strategy: TextMatchStrategy;
}

export function applyPatches(
  originalContent: string,
  patches: PatchFilesPatch[],
): ApplyPatchesResult {
  let content = originalContent;
  let changesApplied = 0;
  const checks: PatchCheck[] = [];

  for (const [patchIndex, patch] of patches.entries()) {
    const result = applyPatch(content, patch, patchIndex);
    if (!result.ok) {
      return {
        ...result,
        patchIndex,
        kind: patch.kind,
      };
    }
    content = result.content;
    changesApplied += result.changesApplied;
    checks.push(...result.checks);
  }

  if (content === originalContent) {
    return {
      ok: false,
      code: "PATCH_NO_CHANGE",
      message: "Patches produced no file changes.",
      suggestedFix: "Use a replacement that changes the file or skip this already-applied patch.",
    };
  }

  return {
    ok: true,
    content,
    patchesApplied: patches.length,
    changesApplied,
    checks,
  };
}

function applyPatch(
  content: string,
  patch: PatchFilesPatch,
  patchIndex: number,
): {
  ok: true;
  content: string;
  changesApplied: number;
  checks: PatchCheck[];
} | PatchApplicationFailure {
  switch (patch.kind) {
    case "replace_text":
    case "replace_all_text":
      return replaceText(content, patch, patchIndex);
    case "insert_before":
    case "insert_after":
      return insertText(content, patch, patchIndex);
    case "replace_lines":
      return replaceLines(content, patch, patchIndex);
  }
}

function replaceText(
  content: string,
  patch: PatchFilesPatch,
  patchIndex: number,
): ReturnType<typeof applyPatch> {
  const find = patch.find ?? "";
  const replacement = convertToLineEnding(
    patch.replace ?? "",
    detectFileLineEnding(content),
  );
  const matches = findTextMatches(content, find);
  if (matches.length === 0) {
    const diagnostic = buildTextTargetDiagnostic(content, find, "find text");
    return {
      ok: false,
      code: "PATCH_TARGET_NOT_FOUND",
      message: "find text not found exactly in file.",
      expected: find,
      actual: diagnostic,
      diagnostic,
      suggestedFix: "Use a small exact target copied from the latest read output, or use replace_lines with fresh line numbers.",
    };
  }
  if (patch.kind === "replace_text" && matches.length > 1) {
    return {
      ok: false,
      code: "PATCH_TARGET_AMBIGUOUS",
      message: "find text matched more than one location.",
      expected: "exactly one match",
      actual: matches.length,
      suggestedFix: "Use a more specific exact find string, or use replace_lines when the intended line is known.",
    };
  }

  const selected = patch.kind === "replace_all_text"
    ? matches
    : matches.slice(0, 1);
  const updated = applyTextMatches(content, selected, replacement);
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

  const strategy = selected[0]?.strategy ?? "exact";
  const checks: PatchCheck[] = [{
    patchIndex,
    kind: patch.kind,
    status: "passed",
    message: strategy === "exact"
      ? "Exact replacement target was applied."
      : "Replacement target was applied after line-ending normalization.",
    matchStrategy: strategy,
  }];
  if (
    patch.kind === "replace_all_text"
    && find !== replacement
    && !replacement.includes(find)
  ) {
    checks.push({
      patchIndex,
      kind: patch.kind,
      status: "passed",
      message: "All exact occurrences of the original text were replaced.",
    });
  }

  return {
    ok: true,
    content: updated,
    changesApplied: selected.length,
    checks,
  };
}

function insertText(
  content: string,
  patch: PatchFilesPatch,
  patchIndex: number,
): ReturnType<typeof applyPatch> {
  const anchor = patch.anchor ?? "";
  const matches = findTextMatches(content, anchor);
  if (matches.length === 0) {
    const diagnostic = buildTextTargetDiagnostic(content, anchor, "anchor text");
    return {
      ok: false,
      code: "PATCH_TARGET_NOT_FOUND",
      message: "anchor text not found exactly in file.",
      expected: anchor,
      actual: diagnostic,
      diagnostic,
      suggestedFix: "Use an exact anchor copied from the latest read output, or use replace_lines.",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: "PATCH_TARGET_AMBIGUOUS",
      message: "anchor text matched more than one location.",
      expected: "exactly one match",
      actual: matches.length,
      suggestedFix: "Use a more specific exact anchor, or use replace_lines when the intended line is known.",
    };
  }

  const match = matches[0]!;
  const insert = convertToLineEnding(
    patch.content ?? "",
    detectFileLineEnding(content),
  );
  const alreadyAdjacent = patch.kind === "insert_before"
    ? content.slice(Math.max(0, match.start - insert.length), match.start) === insert
    : content.slice(match.end, match.end + insert.length) === insert;
  if (alreadyAdjacent) {
    return {
      ok: false,
      code: "PATCH_NO_CHANGE",
      message: "Inserted content is already adjacent to the requested anchor.",
      expected: "new adjacent content",
      actual: "already present",
      suggestedFix: "Skip this already-applied insertion or choose a different anchor and content.",
    };
  }

  const offset = patch.kind === "insert_before" ? match.start : match.end;
  return {
    ok: true,
    content: `${content.slice(0, offset)}${insert}${content.slice(offset)}`,
    changesApplied: 1,
    checks: [{
      patchIndex,
      kind: patch.kind,
      status: "passed",
      message: match.strategy === "exact"
        ? "Content was inserted at the exact anchor."
        : "Content was inserted after line-ending normalization.",
      matchStrategy: match.strategy,
    }],
  };
}

function replaceLines(
  content: string,
  patch: PatchFilesPatch,
  patchIndex: number,
): ReturnType<typeof applyPatch> {
  const startLine = patch.startLine ?? 0;
  const replacement = patch.replace ?? "";
  const newline = detectFileLineEnding(content);
  const preserveFinalLineBreak = hasTrailingLineBreak(content);
  const lines = splitFileLines(content);
  const endLine = patch.endLine === "EOF"
    ? lines.length
    : patch.endLine ?? 0;
  const requestedEndLine = patch.endLine ?? 0;

  if (startLine > lines.length || endLine > lines.length) {
    return {
      ok: false,
      code: "PATCH_TARGET_NOT_FOUND",
      message: `line range ${startLine}-${String(requestedEndLine)} is outside file line count ${lines.length}.`,
      expected: { startLine, endLine: requestedEndLine },
      actual: { lineCount: lines.length },
      suggestedFix: "Read the latest exact line range, then retry with valid 1-based lines or endLine=\"EOF\".",
    };
  }
  if (endLine < startLine) {
    return {
      ok: false,
      code: "PATCH_TARGET_NOT_FOUND",
      message: `line range ${startLine}-${String(requestedEndLine)} is invalid for file line count ${lines.length}.`,
      expected: { startLine, endLine: requestedEndLine },
      actual: { lineCount: lines.length, resolvedEndLine: endLine },
      suggestedFix: "Use an endLine greater than or equal to startLine, or use endLine=\"EOF\".",
    };
  }

  const replacementLines = replacement.length === 0
    ? []
    : splitFileLines(replacement);
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
  const updated = lines.length === 0
    ? ""
    : `${lines.join(newline)}${preserveFinalLineBreak ? newline : ""}`;
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
        ? "Exact line replacement through EOF was applied."
        : replacement.length > 0
          ? "Exact line range was replaced."
          : "Exact line range was removed.",
    }],
  };
}

function findTextMatches(content: string, search: string): TextMatch[] {
  const exact = findExactMatches(content, search, "exact");
  if (exact.length > 0) return exact;

  const newlineAdjusted = convertToLineEnding(
    search,
    detectFileLineEnding(content),
  );
  return newlineAdjusted === search
    ? []
    : findExactMatches(content, newlineAdjusted, "line_ending");
}

function findExactMatches(
  content: string,
  search: string,
  strategy: TextMatchStrategy,
): TextMatch[] {
  const matches: TextMatch[] = [];
  if (search.length === 0) return matches;

  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(search, offset);
    if (index === -1) break;
    matches.push({
      start: index,
      end: index + search.length,
      strategy,
    });
    offset = index + search.length;
  }
  return matches;
}

function applyTextMatches(
  content: string,
  matches: TextMatch[],
  replacement: string,
): string {
  let updated = content;
  for (const match of [...matches].reverse()) {
    updated = `${updated.slice(0, match.start)}${replacement}${updated.slice(match.end)}`;
  }
  return updated;
}

function convertToLineEnding(
  text: string,
  ending: "\n" | "\r\n",
): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return ending === "\r\n"
    ? normalized.replace(/\n/g, "\r\n")
    : normalized;
}
