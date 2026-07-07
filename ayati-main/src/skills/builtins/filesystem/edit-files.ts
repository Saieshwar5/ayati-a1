import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolResult, ToolResultV2 } from "../../types.js";
import { resolveWorkspaceMutationPath } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, succeededContract, successV2 } from "../contract-helpers.js";
import { externalWorkspacePathError } from "./external-path-policy.js";
import { validateEditFilesInput } from "./validators.js";
import type { EditFilesInputEdit, EditFilesMode } from "./types.js";

interface ResolvedEdit {
  index: number;
  requestedPath: string;
  filePath: string;
  edit: EditFilesInputEdit & { mode: EditFilesMode };
}

interface DraftFile {
  requestedPath: string;
  filePath: string;
  updatedContent: string;
  editIndexes: number[];
  changesApplied: number;
}

interface PreparedEditWrite {
  requestedPath: string;
  filePath: string;
  tempPath: string;
  content: string;
  editsApplied: number;
  changesApplied: number;
}

interface MovedEditWrite {
  requestedPath: string;
  filePath: string;
  editsApplied: number;
  changesApplied: number;
  bytesWritten: number;
  sha256: string;
}

export const editFilesTool: ToolDefinition = {
  name: "edit_files",
  description: "Apply multiple deterministic file edits as one serialized batch. Supports exact replace, anchor insert, and 1-based line-range replacement.",
  inputSchema: {
    type: "object",
    required: ["edits"],
    properties: {
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 40,
        items: {
          type: "object",
          required: ["path"],
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative file path by default. Absolute paths outside the workspace require allowExternalPath=true.",
            },
            mode: {
              type: "string",
              enum: ["replace", "insert_before", "insert_after", "replace_range"],
              description: "Edit mode. Defaults to replace.",
            },
            oldString: { type: "string", description: "Text to find for replace mode." },
            newString: { type: "string", description: "Replacement text for replace and replace_range modes." },
            replaceAll: { type: "boolean", description: "Replace all occurrences for replace mode. Defaults to first occurrence only." },
            anchor: { type: "string", description: "Exact anchor text for insert_before or insert_after modes." },
            content: { type: "string", description: "Content to insert for insert_before or insert_after modes." },
            startLine: { type: "integer", minimum: 1, description: "1-based start line for replace_range mode." },
            endLine: { type: "integer", minimum: 1, description: "1-based inclusive end line for replace_range mode." },
          },
          additionalProperties: false,
        },
      },
      allowExternalPath: {
        type: "boolean",
        description: "Allow editing absolute paths outside the configured workspace. Use only when the user explicitly requested those external paths.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["filesEdited", "editsApplied", "changesApplied", "totalBytes", "files"],
    properties: {
      filesEdited: { type: "integer" },
      editsApplied: { type: "integer" },
      changesApplied: { type: "integer" },
      totalBytes: { type: "integer" },
      files: {
        type: "array",
        items: {
          type: "object",
          required: ["requestedPath", "filePath", "editsApplied", "changesApplied", "bytesWritten", "sha256"],
          properties: {
            requestedPath: { type: "string" },
            filePath: { type: "string" },
            editsApplied: { type: "integer" },
            changesApplied: { type: "integer" },
            bytesWritten: { type: "integer" },
            sha256: { type: "string" },
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
        id: "edited_paths_exist",
        kind: "all_paths_exist",
        path: "$.result.structuredContent.files[*].filePath",
      },
      {
        id: "edited_hashes_match",
        kind: "written_hashes_match",
        outputFilesPath: "$.result.structuredContent.files[*]",
      },
    ],
    artifacts: [{ kind: "file", path: "$.result.structuredContent.files[*].filePath" }],
    progressFacts: [{
      kind: "file_edited",
      path: "$.result.structuredContent.files[*].filePath",
      message: "File edited by edit_files.",
    }],
  }),
  errorContract: {
    codes: {
      EDIT_PRECONDITION_FAILED: {
        category: "semantic",
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Read the current file content or line range, then retry edit_files with corrected anchors or ranges."],
      },
      BATCH_EDIT_FAILED: {
        category: "unknown",
        retryable: false,
        recoverable: true,
        suggestedNextActions: ["Inspect diagnostics and retry only after resolving the filesystem error."],
      },
    },
  },
  selectionHints: {
    tags: ["filesystem", "edit", "replace", "insert", "batch", "refactor"],
    aliases: ["batch_edit_files", "replace_in_files", "modify_files"],
    examples: ["apply coordinated edits to multiple files", "insert imports and replace code ranges"],
    domain: "filesystem",
    priority: 5,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateEditFilesInput(input);
    if ("ok" in parsed) return parsed;

    const start = Date.now();
    const resolvedEdits: ResolvedEdit[] = [];
    for (const [index, edit] of parsed.edits.entries()) {
      const resolved = resolveWorkspaceMutationPath(edit.path, {
        allowExternalPath: parsed.allowExternalPath,
        operation: "edit_files",
      });
      if (!resolved.ok) return externalWorkspacePathError(resolved);
      resolvedEdits.push({
        index,
        requestedPath: edit.path,
        filePath: resolved.path,
        edit: { ...edit, mode: edit.mode ?? "replace" },
      });
    }

    const drafts = new Map<string, DraftFile>();
    for (const resolved of resolvedEdits) {
      const existing = drafts.get(resolved.filePath);
      if (existing) {
        existing.editIndexes.push(resolved.index);
        continue;
      }

      try {
        const content = await readFile(resolved.filePath, "utf-8");
        drafts.set(resolved.filePath, {
          requestedPath: resolved.requestedPath,
          filePath: resolved.filePath,
          updatedContent: content,
          editIndexes: [resolved.index],
          changesApplied: 0,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown filesystem read error";
        return errorResult({
          code: "EDIT_PRECONDITION_FAILED",
          message,
          category: "missing_path",
          target: resolved.filePath,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Read or create the target file before retrying edit_files."],
          meta: { durationMs: Date.now() - start, editIndex: resolved.index, filePath: resolved.filePath },
        });
      }
    }

    for (const resolved of resolvedEdits) {
      const draft = drafts.get(resolved.filePath);
      if (!draft) {
        return preconditionError("Resolved edit target was not prepared.", start, resolved);
      }
      const applied = applyEdit(draft.updatedContent, resolved.edit);
      if (!applied.ok) {
        return preconditionError(applied.message, start, resolved, applied.expected, applied.actual);
      }
      draft.updatedContent = applied.content;
      draft.changesApplied += applied.changesApplied;
    }

    const prepared = [...drafts.values()].map((draft): PreparedEditWrite => ({
      requestedPath: draft.requestedPath,
      filePath: draft.filePath,
      tempPath: buildTempPath(draft.filePath),
      content: draft.updatedContent,
      editsApplied: draft.editIndexes.length,
      changesApplied: draft.changesApplied,
    }));
    const tempPaths: string[] = [];
    const moved: MovedEditWrite[] = [];

    try {
      for (const file of prepared) {
        await writeFile(file.tempPath, file.content, "utf-8");
        tempPaths.push(file.tempPath);
      }

      for (const file of prepared) {
        await rename(file.tempPath, file.filePath);
        moved.push({
          requestedPath: file.requestedPath,
          filePath: file.filePath,
          editsApplied: file.editsApplied,
          changesApplied: file.changesApplied,
          bytesWritten: Buffer.byteLength(file.content, "utf-8"),
          sha256: sha256Text(file.content),
        });
      }

      const editsApplied = moved.reduce((sum, file) => sum + file.editsApplied, 0);
      const changesApplied = moved.reduce((sum, file) => sum + file.changesApplied, 0);
      const totalBytes = moved.reduce((sum, file) => sum + file.bytesWritten, 0);
      const structuredContent = {
        filesEdited: moved.length,
        editsApplied,
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
          filesEdited: moved.length,
          editsApplied,
          changesApplied,
          totalBytes,
          files: moved,
        },
        v2: successV2({
          code: "FILES_EDITED",
          message: `Edited ${moved.length} file${moved.length === 1 ? "" : "s"} with ${editsApplied} edit${editsApplied === 1 ? "" : "s"}.`,
          structuredContent,
          artifacts: moved.map((file) => ({
            kind: "file",
            path: file.filePath,
            label: file.requestedPath,
            metadata: {
              editsApplied: file.editsApplied,
              changesApplied: file.changesApplied,
              bytesWritten: file.bytesWritten,
              sha256: file.sha256,
            },
          })),
          diagnostics: {
            durationMs,
            filesEdited: moved.length,
            editsApplied,
            changesApplied,
            totalBytes,
          },
        }),
      };
    } catch (err) {
      await Promise.all(tempPaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
      const message = err instanceof Error ? err.message : "Unknown filesystem batch edit error";
      const durationMs = Date.now() - start;
      return {
        ok: false,
        error: moved.length > 0
          ? `${message} (${moved.length}/${prepared.length} files were already moved into place)`
          : message,
        meta: {
          durationMs,
          filesRequested: prepared.length,
          filesEdited: moved.length,
          partial: moved.length > 0,
          files: moved,
        },
        v2: buildFailureResult(message, err, prepared, moved, durationMs),
      };
    }
  },
};

function applyEdit(
  content: string,
  edit: EditFilesInputEdit & { mode: EditFilesMode },
): { ok: true; content: string; changesApplied: number } | { ok: false; message: string; expected?: unknown; actual?: unknown } {
  switch (edit.mode) {
    case "replace": {
      const oldString = edit.oldString ?? "";
      const newString = edit.newString ?? "";
      if (!content.includes(oldString)) {
        return {
          ok: false,
          message: "oldString not found in file.",
          expected: oldString,
          actual: "not found",
        };
      }
      if (edit.replaceAll) {
        const changesApplied = content.split(oldString).length - 1;
        return { ok: true, content: content.replaceAll(oldString, newString), changesApplied };
      }
      return { ok: true, content: content.replace(oldString, newString), changesApplied: 1 };
    }
    case "insert_before":
    case "insert_after": {
      const anchor = edit.anchor ?? "";
      if (!content.includes(anchor)) {
        return {
          ok: false,
          message: "anchor not found in file.",
          expected: anchor,
          actual: "not found",
        };
      }
      const insert = edit.content ?? "";
      const replacement = edit.mode === "insert_before" ? `${insert}${anchor}` : `${anchor}${insert}`;
      return { ok: true, content: content.replace(anchor, replacement), changesApplied: 1 };
    }
    case "replace_range": {
      const startLine = edit.startLine ?? 0;
      const endLine = edit.endLine ?? 0;
      return replaceLineRange(content, startLine, endLine, edit.newString ?? "");
    }
  }
}

function replaceLineRange(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string,
): { ok: true; content: string; changesApplied: number } | { ok: false; message: string; expected?: unknown; actual?: unknown } {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = /\r?\n$/.test(content);
  const lines = content.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();

  if (startLine > lines.length || endLine > lines.length) {
    return {
      ok: false,
      message: `line range ${startLine}-${endLine} is outside file line count ${lines.length}.`,
      expected: { startLine, endLine },
      actual: { lineCount: lines.length },
    };
  }

  const replacementLines = replacement.length === 0 ? [] : replacement.split(/\r?\n/);
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
  return {
    ok: true,
    content: `${lines.join(newline)}${hasTrailingNewline ? newline : ""}`,
    changesApplied: 1,
  };
}

function preconditionError(
  message: string,
  start: number,
  resolved: ResolvedEdit,
  expected?: unknown,
  actual?: unknown,
): ToolResult {
  return errorResult({
    code: "EDIT_PRECONDITION_FAILED",
    message,
    category: "semantic",
    target: resolved.filePath,
    expected,
    actual,
    retryable: true,
    recoverable: true,
    suggestedNextActions: ["Read the current file content or line range, then retry edit_files with corrected anchors or ranges."],
    structuredContent: {
      failedEditIndex: resolved.index,
      requestedPath: resolved.requestedPath,
      filePath: resolved.filePath,
      mode: resolved.edit.mode,
    },
    meta: {
      durationMs: Date.now() - start,
      failedEditIndex: resolved.index,
      filePath: resolved.filePath,
      mode: resolved.edit.mode,
    },
  });
}

function buildFailureResult(
  message: string,
  err: unknown,
  prepared: PreparedEditWrite[],
  moved: MovedEditWrite[],
  durationMs: number,
): ToolResultV2 {
  const errno = err as NodeJS.ErrnoException;
  return {
    transportOk: true,
    operationStatus: moved.length > 0 ? "partial" : "failed",
    code: "BATCH_EDIT_FAILED",
    message: moved.length > 0
      ? `${message} (${moved.length}/${prepared.length} files were already moved into place)`
      : message,
    structuredContent: {
      filesRequested: prepared.length,
      filesEdited: moved.length,
      partial: moved.length > 0,
      files: moved,
    },
    artifacts: moved.map((file) => ({
      kind: "file",
      path: file.filePath,
      label: file.requestedPath,
      metadata: {
        editsApplied: file.editsApplied,
        changesApplied: file.changesApplied,
        bytesWritten: file.bytesWritten,
        sha256: file.sha256,
      },
    })),
    error: {
      category: "unknown",
      code: "BATCH_EDIT_FAILED",
      message,
      retryable: false,
      recoverable: true,
      ...(typeof errno.path === "string" ? { target: errno.path } : {}),
      suggestedNextActions: ["Inspect diagnostics and retry only after resolving the filesystem error."],
    },
    diagnostics: {
      durationMs,
      filesRequested: prepared.length,
      filesEdited: moved.length,
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
