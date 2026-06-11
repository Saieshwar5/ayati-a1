import { readFile, stat } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { resolveWorkspacePath } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, errorResultFromUnknown, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { validateReadFileInput } from "./validators.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_OUTPUT_CHARS = 100_000;

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read text file contents. Supports line offset/limit for large files.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute or relative file path." },
      offset: { type: "number", description: "Line number to start reading from (0-based)." },
      limit: { type: "number", description: "Maximum number of lines to read." },
    },
  },
  outputSchema: {
    type: "object",
    required: ["requestedPath", "filePath", "content", "lineCount", "truncated", "sizeBytes"],
    properties: {
      requestedPath: { type: "string" },
      filePath: { type: "string" },
      content: { type: "string" },
      lineCount: { type: "integer" },
      truncated: { type: "boolean" },
      sizeBytes: { type: "integer" },
      offset: { type: "integer" },
      limit: { type: "integer" },
    },
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: true,
  }),
  resultContract: succeededContract({
    assertions: [
      {
        id: "read_file_exists",
        kind: "file_exists",
        path: "$.result.structuredContent.filePath",
      },
      {
        id: "read_content_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.content",
      },
    ],
    artifacts: [{ kind: "file", path: "$.result.structuredContent.filePath" }],
    progressFacts: [{
      kind: "file_read",
      path: "$.result.structuredContent.filePath",
      message: "File read by read_file.",
    }],
  }),
  selectionHints: {
    tags: ["filesystem", "read", "file", "content"],
    aliases: ["cat_file", "open_file"],
    examples: ["read this file", "show file content"],
    domain: "filesystem",
    priority: 4,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateReadFileInput(input);
    if ("ok" in parsed) return parsed;

    const filePath = resolveWorkspacePath(parsed.path);
    const start = Date.now();

    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return errorResult({
          code: "NOT_A_FILE",
          message: `Not a file: ${filePath}`,
          category: "semantic",
          target: filePath,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Use list_directory for directories or choose a regular file path."],
          meta: { durationMs: Date.now() - start, filePath },
        });
      }
      if (info.size > MAX_FILE_SIZE) {
        return errorResult({
          code: "FILE_TOO_LARGE",
          message: `File too large: ${(info.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit.`,
          category: "validation",
          target: filePath,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Retry with offset and limit if a smaller line slice is enough, or use a streaming/summary tool."],
          meta: { durationMs: Date.now() - start, filePath, sizeBytes: info.size },
        });
      }

      const raw = await readFile(filePath, "utf-8");
      let lines = raw.split("\n");

      if (parsed.offset !== undefined) {
        lines = lines.slice(parsed.offset);
      }
      if (parsed.limit !== undefined) {
        lines = lines.slice(0, parsed.limit);
      }

      let output = lines.join("\n");
      let truncated = false;

      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + "\n...[truncated]";
        truncated = true;
      }

      const durationMs = Date.now() - start;
      const structuredContent = {
        requestedPath: parsed.path,
        filePath,
        content: output,
        lineCount: lines.length,
        truncated,
        sizeBytes: info.size,
        ...(parsed.offset !== undefined ? { offset: parsed.offset } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      };
      const meta = {
        durationMs,
        filePath,
        lineCount: lines.length,
        truncated,
      };
      return okResult({
        output,
        meta,
        v2: successV2({
          code: "FILE_READ",
          message: `Read file: ${filePath}`,
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
