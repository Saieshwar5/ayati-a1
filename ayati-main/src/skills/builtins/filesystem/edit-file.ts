import { readFile, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { resolveWorkspaceMutationPath } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, errorResultFromUnknown, okResult, sha256Text, succeededContract, successV2 } from "../contract-helpers.js";
import { externalWorkspacePathError } from "./external-path-policy.js";
import { validateEditFileInput } from "./validators.js";

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description: "Find and replace text within a file. Can replace a single or all occurrences.",
  inputSchema: {
    type: "object",
    required: ["path", "oldString", "newString"],
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative file path by default. Absolute paths outside the workspace require allowExternalPath=true.",
      },
      oldString: { type: "string", description: "Text to find." },
      newString: { type: "string", description: "Text to replace with." },
      replaceAll: {
        type: "boolean",
        description: "Replace all occurrences (default: false, replaces first only).",
      },
      allowExternalPath: {
        type: "boolean",
        description: "Allow editing an absolute path outside the configured workspace. Use only when the user explicitly requested that external path.",
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["requestedPath", "filePath", "replacements", "bytesWritten", "sha256"],
    properties: {
      requestedPath: { type: "string" },
      filePath: { type: "string" },
      replacements: { type: "integer" },
      replaceAll: { type: "boolean" },
      bytesWritten: { type: "integer" },
      sha256: { type: "string" },
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
        id: "edited_file_hash_matches",
        kind: "file_hash_matches",
        path: "$.result.structuredContent.filePath",
        sha256Path: "$.result.structuredContent.sha256",
      },
    ],
    artifacts: [{ kind: "file", path: "$.result.structuredContent.filePath" }],
    progressFacts: [{
      kind: "file_edited",
      path: "$.result.structuredContent.filePath",
      message: "File edited by edit_file.",
    }],
  }),
  selectionHints: {
    tags: ["filesystem", "edit", "replace", "update"],
    aliases: ["replace_in_file", "modify_file"],
    examples: ["replace text in file", "edit config value"],
    domain: "filesystem",
    priority: 4,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateEditFileInput(input);
    if ("ok" in parsed) return parsed;

    const resolved = resolveWorkspaceMutationPath(parsed.path, {
      allowExternalPath: parsed.allowExternalPath,
      operation: "edit_file",
    });
    if (!resolved.ok) return externalWorkspacePathError(resolved);

    const filePath = resolved.path;
    const start = Date.now();

    try {
      const content = await readFile(filePath, "utf-8");

      if (!content.includes(parsed.oldString)) {
        return errorResult({
          code: "OLD_STRING_NOT_FOUND",
          message: "oldString not found in file.",
          category: "semantic",
          target: filePath,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Read the file to get the current content, then retry edit_file with the exact oldString."],
          meta: { durationMs: Date.now() - start, filePath },
        });
      }

      let updated: string;
      let count: number;

      if (parsed.replaceAll) {
        count = content.split(parsed.oldString).length - 1;
        updated = content.replaceAll(parsed.oldString, parsed.newString);
      } else {
        count = 1;
        updated = content.replace(parsed.oldString, parsed.newString);
      }

      await writeFile(filePath, updated, "utf-8");

      const durationMs = Date.now() - start;
      const bytesWritten = Buffer.byteLength(updated, "utf-8");
      const structuredContent = {
        requestedPath: parsed.path,
        filePath,
        replacements: count,
        replaceAll: parsed.replaceAll === true,
        bytesWritten,
        sha256: sha256Text(updated),
      };
      const meta = { durationMs, filePath, replacements: count, bytesWritten };
      return okResult({
        output: `Replaced ${count} occurrence${count > 1 ? "s" : ""} in ${filePath}`,
        meta,
        v2: successV2({
          code: "FILE_EDITED",
          message: `Edited file: ${filePath}`,
          structuredContent,
          artifacts: [{ kind: "file", path: filePath }],
          diagnostics: meta,
        }),
      });
    } catch (err) {
      return errorResultFromUnknown({
        err,
        fallbackMessage: "Unknown filesystem error",
        target: filePath,
        meta: { durationMs: Date.now() - start, filePath },
      });
    }
  },
};
