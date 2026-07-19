import type { DirectoryLibrary } from "../../../files/directory-library.js";
import type { FileLibrary } from "../../../files/file-library.js";
import type { ManagedFileRecord } from "../../../files/types.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import { requireAbsolutePath } from "../../workspace-paths.js";

export interface FilesSkillDeps {
  fileLibrary: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
}

const FILES_PROMPT_BLOCK = [
  "Managed file tools are built in.",
  "Once a file matters to durable work, register it and use its fileId instead of raw paths.",
  "Attached files are registered before the agent loop runs and can be auto-selected when there is exactly one run file.",
  "Use file_describe to inspect file metadata and capabilities.",
  "After workstream binding, use file_register_path when filesystem search finds one local file the user wants in the managed file library.",
  "Pass canonical absolute filesystem paths to file_register_path and file_register_artifact.",
  "Use file_fetch_url when the current work requires downloading a file from a URL.",
  "Use file_read_text or file_query for text-capable files.",
  "Use file_profile_table and file_query_table for CSV/XLSX table files. The staged table name is file_data.",
  "Prefer attachment_list, attachment_inspect, attachment_read, attachment_query, attachment_query_table, and directory_search for attached inputs.",
].join("\n");

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
    createFileFetchUrlTool(deps),
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
    promptBlock: FILES_PROMPT_BLOCK,
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
    selectionHints: {
      tags: ["attachment", "list", "file", "directory"],
      domain: "attachments",
      priority: 100,
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
    selectionHints: {
      tags: ["attachment", "inspect", "describe", "metadata"],
      domain: "attachments",
      priority: 100,
    },
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
    selectionHints: {
      tags: ["attachment", "read", "file", "directory"],
      domain: "attachments",
      priority: 98,
    },
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
    selectionHints: {
      tags: ["attachment", "query", "search", "document", "directory"],
      domain: "attachments",
      priority: 100,
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
    selectionHints: {
      tags: ["attachment", "table", "query", "csv", "xlsx"],
      domain: "attachments",
      priority: 99,
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
    selectionHints: {
      tags: ["directory", "attachment", "search", "grep", "find"],
      domain: "attachments",
      priority: 98,
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
    selectionHints: {
      tags: ["file", "register", "path", "local", "workstream-bound"],
      aliases: ["register bound workstream file", "add local file to managed library"],
      domain: "files",
      priority: 95,
    },
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
        path: { type: "string", description: "Canonical absolute path of the generated artifact." },
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
          path: readRequiredAbsolutePath(input, "path"),
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
