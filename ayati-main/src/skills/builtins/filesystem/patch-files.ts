import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolResult, ToolResultV2 } from "../../types.js";
import { resolveWorkspaceMutationPath } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, succeededContract, successV2 } from "../contract-helpers.js";
import { externalWorkspacePathError } from "./external-path-policy.js";
import { validatePatchFilesInput } from "./validators.js";
import type { PatchFilesPatch } from "./types.js";

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
        maxItems: 20,
        items: {
          type: "object",
          required: ["path", "patches"],
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative file path by default. Absolute paths outside the workspace require allowExternalPath=true.",
            },
            patches: {
              type: "array",
              minItems: 1,
              maxItems: 20,
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
                  endLine: { type: "integer", minimum: 1, description: "1-based inclusive end line for replace_lines." },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      allowExternalPath: {
        type: "boolean",
        description: "Allow patching absolute paths outside the configured workspace. Use only when the user explicitly requested those external paths.",
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
    aliases: ["apply_patches", "patch_in_files", "stable_edit_files", "modify_files"],
    examples: ["replace background: white with background: #f6f1e7", "patch two files with small stable targets"],
    domain: "filesystem",
    priority: 6,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validatePatchFilesInput(input);
    if ("ok" in parsed) return parsed;

    const start = Date.now();
    const resolvedFiles: ResolvedPatchFile[] = [];
    for (const file of parsed.files) {
      const resolved = resolveWorkspaceMutationPath(file.path, {
        allowExternalPath: parsed.allowExternalPath,
        operation: "patch_files",
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
  suggestedFix: string;
} {
  switch (patch.kind) {
    case "replace_text":
    case "replace_all_text": {
      const find = patch.find ?? "";
      const replace = patch.replace ?? "";
      if (!content.includes(find)) {
        return {
          ok: false,
          code: "PATCH_TARGET_NOT_FOUND",
          message: "find text not found in file.",
          expected: find,
          actual: "not found",
          suggestedFix: "Use a smaller stable target copied from the latest read output, for example just the property/value or identifier being changed.",
        };
      }
      const occurrenceCount = content.split(find).length - 1;
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
      const updated = patch.kind === "replace_all_text"
        ? content.replaceAll(find, replace)
        : content.replace(find, replace);
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
        message: "Replacement text is present after patch.",
      }];
      if (patch.kind === "replace_all_text" && find !== replace && !replace.includes(find)) {
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
      if (!content.includes(anchor)) {
        return {
          ok: false,
          code: "PATCH_TARGET_NOT_FOUND",
          message: "anchor text not found in file.",
          expected: anchor,
          actual: "not found",
          suggestedFix: "Use an anchor copied exactly from the latest read output or use replace_lines.",
        };
      }
      const occurrenceCount = content.split(anchor).length - 1;
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
      const replacement = patch.kind === "insert_before" ? `${insert}${anchor}` : `${anchor}${insert}`;
      return {
        ok: true,
        content: content.replace(anchor, replacement),
        changesApplied: 1,
        checks: [{
          patchIndex,
          kind: patch.kind,
          status: "passed",
          message: "Inserted content is present after patch.",
        }],
      };
    }
    case "replace_lines":
      return replaceLines(content, patch, patchIndex);
  }
}

function replaceLines(
  content: string,
  patch: PatchFilesPatch,
  patchIndex: number,
): ReturnType<typeof applyPatch> {
  const startLine = patch.startLine ?? 0;
  const endLine = patch.endLine ?? 0;
  const replacement = patch.replace ?? "";
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = /\r?\n$/.test(content);
  const lines = content.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();

  if (startLine > lines.length || endLine > lines.length) {
    return {
      ok: false,
      code: "PATCH_TARGET_NOT_FOUND",
      message: `line range ${startLine}-${endLine} is outside file line count ${lines.length}.`,
      expected: { startLine, endLine },
      actual: { lineCount: lines.length },
      suggestedFix: "Read the latest exact line range, then retry replace_lines with valid 1-based lines.",
    };
  }

  const replacementLines = replacement.length === 0 ? [] : replacement.split(/\r?\n/);
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
  const updated = `${lines.join(newline)}${hasTrailingNewline ? newline : ""}`;
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
      message: replacement.length > 0 ? "Replacement lines are present after patch." : "Line range was removed.",
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
  suggestedFix: string;
}): ToolResult {
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
    },
    meta: {
      durationMs: Date.now() - input.start,
      filePath: input.file.filePath,
      ...(input.patchIndex !== undefined ? { patchIndex: input.patchIndex } : {}),
      ...(input.patch ? { kind: input.patch.kind } : {}),
    },
  });
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
