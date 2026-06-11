import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { resolveWorkspacePath } from "../../workspace-paths.js";
import { commonAnnotations, errorResultFromUnknown, okResult, sha256Text, succeededContract, successV2 } from "../contract-helpers.js";
import { validateWriteFileInput } from "./validators.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Write or overwrite a file. Optionally creates parent directories.",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Absolute or relative file path." },
      content: { type: "string", description: "Content to write." },
      createDirs: {
        type: "boolean",
        description: "Create parent directories if they don't exist (default: false).",
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["requestedPath", "filePath", "bytesWritten", "charactersWritten", "sha256"],
    properties: {
      requestedPath: { type: "string" },
      filePath: { type: "string" },
      bytesWritten: { type: "integer" },
      charactersWritten: { type: "integer" },
      sha256: { type: "string" },
      createdParentDirectories: { type: "boolean" },
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
        id: "written_file_hash_matches",
        kind: "file_hash_matches",
        path: "$.result.structuredContent.filePath",
        sha256Path: "$.result.structuredContent.sha256",
      },
    ],
    artifacts: [{ kind: "file", path: "$.result.structuredContent.filePath" }],
    progressFacts: [{
      kind: "file_written",
      path: "$.result.structuredContent.filePath",
      message: "File written by write_file.",
    }],
  }),
  selectionHints: {
    tags: ["filesystem", "write", "create", "file"],
    aliases: ["save_file", "overwrite_file"],
    examples: ["write content to file", "create file with text"],
    domain: "filesystem",
    priority: 3,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateWriteFileInput(input);
    if ("ok" in parsed) return parsed;

    const filePath = resolveWorkspacePath(parsed.path);
    const start = Date.now();

    try {
      if (parsed.createDirs) {
        await mkdir(dirname(filePath), { recursive: true });
      }

      await writeFile(filePath, parsed.content, "utf-8");

      const durationMs = Date.now() - start;
      const bytesWritten = Buffer.byteLength(parsed.content, "utf-8");
      const structuredContent = {
        requestedPath: parsed.path,
        filePath,
        bytesWritten,
        charactersWritten: parsed.content.length,
        sha256: sha256Text(parsed.content),
        createdParentDirectories: parsed.createDirs === true,
      };
      const meta = { durationMs, filePath, bytesWritten };
      return okResult({
        output: `Written ${parsed.content.length} characters to ${filePath}`,
        meta,
        v2: successV2({
          code: "FILE_WRITTEN",
          message: `Wrote file: ${filePath}`,
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
