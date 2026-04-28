import type { FileLibrary } from "../../../files/file-library.js";
import type { ManagedFileRecord } from "../../../files/types.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";

export interface FilesSkillDeps {
  fileLibrary: FileLibrary;
}

const FILES_PROMPT_BLOCK = [
  "Managed file tools are built in.",
  "Once a file matters to a task, register it and use its fileId instead of raw paths.",
  "Attached files are registered before the controller runs and can be auto-selected when there is exactly one run file.",
  "Use file_describe to inspect file metadata and capabilities.",
  "Use file_register_path after filesystem search finds a local file the user wants to work on.",
  "Use file_fetch_url when the task requires downloading a file from a URL.",
  "Use file_read_text or file_query for text-capable files.",
  "Use file_profile_table and file_query_table for CSV/XLSX table files. The staged table name is file_data.",
].join("\n");

export function createFilesSkill(deps: FilesSkillDeps): SkillDefinition {
  return {
    id: "files",
    version: "1.0.0",
    description: "Managed file registration, extraction, and querying tools.",
    promptBlock: FILES_PROMPT_BLOCK,
    tools: [
      createFileDescribeTool(deps),
      createFileRegisterPathTool(deps),
      createFileFetchUrlTool(deps),
      createFileRegisterArtifactTool(deps),
      createFileReadTextTool(deps),
      createFileQueryTool(deps),
      createFileProfileTableTool(deps),
      createFileQueryTableTool(deps),
    ],
  };
}

function createFileDescribeTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_describe",
    description: "Describe a managed file's metadata, capabilities, and processing status.",
    inputSchema: optionalFileIdSchema(),
    selectionHints: {
      tags: ["file", "describe", "metadata"],
      domain: "files",
      priority: 80,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const fileId = await resolveFileId(deps.fileLibrary, input, context);
        return deps.fileLibrary.describeFile(fileId);
      });
    },
  };
}

function createFileRegisterPathTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_register_path",
    description: "Register a local file path into the managed file library and return its fileId.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["file", "register", "path", "local"],
      domain: "files",
      priority: 95,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const record = await deps.fileLibrary.registerPath({
          path: readRequiredString(input, "path"),
          name: readOptionalString(input, "name"),
          runId: context?.runId,
          runRole: "found",
        });
        return { file: summarizeToolFile(record) };
      });
    },
  };
}

function createFileFetchUrlTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_fetch_url",
    description: "Download a URL into the managed file library and return its fileId.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        originalName: { type: "string" },
        mimeType: { type: "string" },
        maxBytes: { type: "number" },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["file", "download", "url", "fetch"],
      domain: "files",
      priority: 90,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const record = await deps.fileLibrary.registerDownload({
          url: readRequiredString(input, "url"),
          originalName: readOptionalString(input, "originalName"),
          mimeType: readOptionalString(input, "mimeType"),
          maxBytes: readOptionalNumber(input, "maxBytes"),
          runId: context?.runId,
        });
        return { file: summarizeToolFile(record) };
      });
    },
  };
}

function createFileRegisterArtifactTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_register_artifact",
    description: "Register a generated artifact path into the managed file library and return its fileId.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["file", "register", "artifact", "generated"],
      domain: "files",
      priority: 85,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const record = await deps.fileLibrary.registerArtifact({
          path: readRequiredString(input, "path"),
          name: readOptionalString(input, "name"),
          runId: context?.runId,
        });
        return { file: summarizeToolFile(record) };
      });
    },
  };
}

function createFileReadTextTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_read_text",
    description: "Read extracted text from a managed text-capable file.",
    inputSchema: optionalFileIdSchema(),
    selectionHints: {
      tags: ["file", "read", "text", "document"],
      domain: "files",
      priority: 90,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const fileId = await resolveFileId(deps.fileLibrary, input, context);
        return deps.fileLibrary.readText(fileId);
      });
    },
  };
}

function createFileQueryTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_query",
    description: "Search/query extracted text chunks from a managed file.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        fileId: { type: "string" },
        query: { type: "string" },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["file", "query", "document", "text"],
      domain: "files",
      priority: 95,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const fileId = await resolveFileId(deps.fileLibrary, input, context);
        return deps.fileLibrary.queryText({
          fileId,
          query: readRequiredString(input, "query"),
        });
      });
    },
  };
}

function createFileProfileTableTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_profile_table",
    description: "Profile a managed CSV/XLSX file and return schema, sample rows, and SQLite staging info.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        sheetName: { type: "string" },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["file", "table", "csv", "xlsx", "profile"],
      domain: "files",
      priority: 88,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const fileId = await resolveFileId(deps.fileLibrary, input, context);
        return deps.fileLibrary.profileTable({
          fileId,
          sheetName: readOptionalString(input, "sheetName"),
        });
      });
    },
  };
}

function createFileQueryTableTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_query_table",
    description: "Run a SELECT query against a managed CSV/XLSX file. The table name is file_data.",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: {
        fileId: { type: "string" },
        sql: { type: "string" },
        sheetName: { type: "string" },
        maxRows: { type: "number" },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["file", "table", "sql", "query", "csv", "xlsx"],
      domain: "files",
      priority: 96,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const fileId = await resolveFileId(deps.fileLibrary, input, context);
        return deps.fileLibrary.queryTable({
          fileId,
          sql: readRequiredString(input, "sql"),
          sheetName: readOptionalString(input, "sheetName"),
          maxRows: readOptionalNumber(input, "maxRows"),
        });
      });
    },
  };
}

async function resolveFileId(
  fileLibrary: FileLibrary,
  input: unknown,
  context?: ToolExecutionContext,
): Promise<string> {
  const explicit = readOptionalString(input, "fileId");
  if (explicit) {
    if (context?.runId) {
      await fileLibrary.touchRunFile(context.runId, explicit, "used");
    }
    return explicit;
  }

  if (!context?.runId) {
    throw new Error("fileId is required when the tool execution context has no runId.");
  }
  const files = await fileLibrary.listRunFiles(context.runId);
  if (files.length === 1) {
    return files[0]!.fileId;
  }
  if (files.length === 0) {
    throw new Error("No managed files are available for this run.");
  }
  throw new Error(`Unable to auto-select a file. Available files: ${files.map((file) => `${file.fileId} (${file.originalName})`).join(", ")}`);
}

function optionalFileIdSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      fileId: { type: "string" },
    },
    additionalProperties: false,
  };
}

async function withJsonResult(fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return {
      ok: true,
      output: JSON.stringify(await fn(), null, 2),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readRequiredString(input: unknown, key: string): string {
  const value = readOptionalString(input, key);
  if (!value) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalNumber(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function summarizeToolFile(file: ManagedFileRecord): Record<string, unknown> {
  return {
    fileId: file.fileId,
    originalName: file.originalName,
    kind: file.kind,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    capabilities: file.capabilities,
    processingStatus: file.processingStatus,
    warnings: file.warnings,
  };
}
