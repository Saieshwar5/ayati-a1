import type { DirectoryLibrary } from "../../../files/directory-library.js";
import type { FileLibrary } from "../../../files/file-library.js";
import type { ManagedFileRecord } from "../../../files/types.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import { requireAbsolutePath } from "../../workspace-paths.js";
import {
  genericObjectOutputSchema,
  succeededContract,
} from "../contract-helpers.js";

export interface FilesSkillDeps {
  fileLibrary: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
}

export function createFilesSkill(deps: FilesSkillDeps): SkillDefinition {
  const tools = [
    createAttachmentListTool(deps),
    createAttachmentInspectTool(deps),
    createAttachmentReadTool(deps),
    createAttachmentQueryTool(deps),
    createAttachmentQueryTableTool(deps),
    ...(deps.directoryLibrary ? [createDirectorySearchTool(deps)] : []),
    createFileDescribeTool(deps),
    createFileRegisterPathTool(deps),
    createFileRegisterArtifactTool(deps),
    createFileReadTextTool(deps),
    createFileQueryTool(deps),
    createFileProfileTableTool(deps),
    createFileQueryTableTool(deps),
  ];

  return {
    id: "files",
    version: "1.0.0",
    description: "Managed file registration, extraction, and querying tools.",
    tools,
  };
}

function createAttachmentListTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "attachment_list",
    description: "List managed files and directories attached to the current run.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        if (!context?.runId) {
          throw new Error("runId is required to list run attachments.");
        }
        const files = await deps.fileLibrary.listRunFiles(context.runId);
        const directories = deps.directoryLibrary
          ? await deps.directoryLibrary.listRunDirectories(context.runId)
          : [];
        return {
          files: files.map(summarizeToolFile),
          directories: directories.map((directory) => ({
            directoryId: directory.directoryId,
            name: directory.name,
            rootPath: directory.rootPath,
            status: directory.status,
            fileCount: directory.fileCount,
            directoryCount: directory.directoryCount,
            truncated: directory.truncated,
            capabilities: directory.capabilities,
            warnings: directory.warnings,
          })),
        };
      });
    },
  };
}

function createAttachmentInspectTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "attachment_inspect",
    description: "Inspect one attached file or directory by attachmentId, fileId, or directoryId.",
    inputSchema: optionalAttachmentIdSchema(),
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const ref = await resolveAttachmentRef(deps, input, context);
        if (ref.type === "directory") {
          return {
            type: "directory",
            directory: await requireDirectoryLibrary(deps).describeDirectory(ref.directoryId),
          };
        }
        return {
          type: "file",
          file: await deps.fileLibrary.describeFile(ref.fileId),
        };
      });
    },
  };
}

function createAttachmentReadTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "attachment_read",
    description: "Read a text-capable attached file, or return a directory attachment manifest preview.",
    inputSchema: optionalAttachmentIdSchema(),
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const ref = await resolveAttachmentRef(deps, input, context);
        if (ref.type === "directory") {
          return {
            type: "directory",
            directory: await requireDirectoryLibrary(deps).describeDirectory(ref.directoryId),
          };
        }
        return {
          type: "file",
          ...(await deps.fileLibrary.readText(ref.fileId)),
        };
      });
    },
  };
}

function createAttachmentQueryTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "attachment_query",
    description: "Query a text-capable attached file, or search an attached directory by path/name/content.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        attachmentId: { type: "string" },
        fileId: { type: "string" },
        directoryId: { type: "string" },
        query: { type: "string" },
        searchContents: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        maxResults: { type: "number" },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const query = readRequiredString(input, "query");
        const ref = await resolveAttachmentRef(deps, input, context);
        if (ref.type === "directory") {
          return {
            type: "directory",
            ...(await requireDirectoryLibrary(deps).searchDirectory({
              directoryId: ref.directoryId,
              query,
              searchContents: readOptionalBoolean(input, "searchContents"),
              caseSensitive: readOptionalBoolean(input, "caseSensitive"),
              maxResults: readOptionalNumber(input, "maxResults"),
            })),
          };
        }
        return {
          type: "file",
          ...(await deps.fileLibrary.queryText({ fileId: ref.fileId, query })),
        };
      });
    },
  };
}

function createAttachmentQueryTableTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "attachment_query_table",
    description: "Run a SELECT query against an attached CSV/XLSX file. The table name is file_data.",
    inputSchema: {
      type: "object",
      required: ["sql"],
      properties: {
        attachmentId: { type: "string" },
        fileId: { type: "string" },
        sql: { type: "string" },
        sheetName: { type: "string" },
        maxRows: { type: "number" },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const ref = await resolveAttachmentRef(deps, input, context);
        if (ref.type !== "file") {
          throw new Error("attachment_query_table requires a file attachment.");
        }
        return deps.fileLibrary.queryTable({
          fileId: ref.fileId,
          sql: readRequiredString(input, "sql"),
          sheetName: readOptionalString(input, "sheetName"),
          maxRows: readOptionalNumber(input, "maxRows"),
        });
      });
    },
  };
}

function createDirectorySearchTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "directory_search",
    description: "Search an attached directory by path/name, or search file contents with searchContents=true.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        directoryId: { type: "string" },
        query: { type: "string" },
        searchContents: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        maxResults: { type: "number" },
        maxFileBytes: { type: "number" },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const directoryId = await resolveDirectoryId(deps, input, context);
        return requireDirectoryLibrary(deps).searchDirectory({
          directoryId,
          query: readRequiredString(input, "query"),
          searchContents: readOptionalBoolean(input, "searchContents"),
          caseSensitive: readOptionalBoolean(input, "caseSensitive"),
          maxResults: readOptionalNumber(input, "maxResults"),
          maxFileBytes: readOptionalNumber(input, "maxFileBytes"),
        });
      });
    },
  };
}

function createFileDescribeTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_describe",
    description: "Describe a managed file's metadata, capabilities, and processing status.",
    inputSchema: optionalFileIdSchema(),
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
    description: "After workstream binding, register one local file in the managed file library and return its fileId. Do not use this to adopt or route an existing project directory.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Canonical absolute path of the local file." },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: genericObjectOutputSchema,
    resultContract: fileRegistrationContract(),
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const record = await deps.fileLibrary.registerPath({
          path: readRequiredAbsolutePath(input, "path"),
          name: readOptionalString(input, "name"),
          runId: context?.runId,
          runRole: "found",
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
        path: { type: "string", description: "Canonical absolute path of the generated artifact." },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: genericObjectOutputSchema,
    resultContract: fileRegistrationContract(),
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const record = await deps.fileLibrary.registerArtifact({
          path: readRequiredAbsolutePath(input, "path"),
          name: readOptionalString(input, "name"),
          runId: context?.runId,
        });
        return { file: summarizeToolFile(record) };
      });
    },
  };
}

function fileRegistrationContract(): ReturnType<typeof succeededContract> {
  return succeededContract({
    assertions: [{
      id: "registered_file_id_present",
      kind: "json_path_exists",
      path: "$.result.structuredContent.file.fileId",
    }],
    progressFacts: [{
      kind: "artifact_registered",
      path: "$.result.structuredContent.file.fileId",
      message: "Managed file artifact was registered.",
    }],
  });
}

function createFileReadTextTool(deps: FilesSkillDeps): ToolDefinition {
  return {
    name: "file_read_text",
    description: "Read extracted text from a managed text-capable file.",
    inputSchema: optionalFileIdSchema(),
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

type AttachmentRef =
  | { type: "file"; fileId: string }
  | { type: "directory"; directoryId: string };

async function resolveAttachmentRef(
  deps: FilesSkillDeps,
  input: unknown,
  context?: ToolExecutionContext,
): Promise<AttachmentRef> {
  const attachmentId = readOptionalString(input, "attachmentId");
  const fileId = readOptionalString(input, "fileId");
  const directoryId = readOptionalString(input, "directoryId");

  const explicit = attachmentId ?? fileId ?? directoryId;
  if (explicit?.startsWith("dir_")) {
    const directoryLibrary = requireDirectoryLibrary(deps);
    if (context?.runId) {
      await directoryLibrary.touchRunDirectory(context.runId, explicit, "used");
    }
    return { type: "directory", directoryId: explicit };
  }

  if (explicit?.startsWith("file_")) {
    if (context?.runId) {
      await deps.fileLibrary.touchRunFile(context.runId, explicit, "used");
    }
    return { type: "file", fileId: explicit };
  }

  if (attachmentId) {
    throw new Error(`Invalid attachmentId: ${attachmentId}`);
  }

  if (fileId) {
    return { type: "file", fileId };
  }
  if (directoryId) {
    return { type: "directory", directoryId };
  }

  if (!context?.runId) {
    throw new Error("attachmentId is required when the tool execution context has no runId.");
  }

  const files = await deps.fileLibrary.listRunFiles(context.runId);
  const directories = deps.directoryLibrary
    ? await deps.directoryLibrary.listRunDirectories(context.runId)
    : [];
  const total = files.length + directories.length;
  if (total === 1 && files.length === 1) {
    return { type: "file", fileId: files[0]!.fileId };
  }
  if (total === 1 && directories.length === 1) {
    return { type: "directory", directoryId: directories[0]!.directoryId };
  }
  if (total === 0) {
    throw new Error("No attachments are available for this run.");
  }
  const labels = [
    ...files.map((file) => `${file.fileId} (${file.originalName})`),
    ...directories.map((directory) => `${directory.directoryId} (${directory.name})`),
  ];
  throw new Error(`Unable to auto-select an attachment. Available attachments: ${labels.join(", ")}`);
}

async function resolveDirectoryId(
  deps: FilesSkillDeps,
  input: unknown,
  context?: ToolExecutionContext,
): Promise<string> {
  const explicit = readOptionalString(input, "directoryId");
  const directoryLibrary = requireDirectoryLibrary(deps);
  if (explicit) {
    if (context?.runId) {
      await directoryLibrary.touchRunDirectory(context.runId, explicit, "used");
    }
    return explicit;
  }

  if (!context?.runId) {
    throw new Error("directoryId is required when the tool execution context has no runId.");
  }

  const directories = await directoryLibrary.listRunDirectories(context.runId);
  if (directories.length === 1) {
    return directories[0]!.directoryId;
  }
  if (directories.length === 0) {
    throw new Error("No managed directories are available for this run.");
  }
  throw new Error(`Unable to auto-select a directory. Available directories: ${directories.map((directory) => `${directory.directoryId} (${directory.name})`).join(", ")}`);
}

function requireDirectoryLibrary(deps: FilesSkillDeps): DirectoryLibrary {
  if (!deps.directoryLibrary) {
    throw new Error("Directory attachments are not configured.");
  }
  return deps.directoryLibrary;
}

function optionalAttachmentIdSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      attachmentId: { type: "string" },
      fileId: { type: "string" },
      directoryId: { type: "string" },
    },
    additionalProperties: false,
  };
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

function readRequiredAbsolutePath(input: unknown, key: string): string {
  const value = readRequiredString(input, key);
  const result = requireAbsolutePath(value, key);
  if (!result.ok) throw new Error(result.message);
  return result.absolutePath;
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

function readOptionalBoolean(input: unknown, key: string): boolean | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
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
