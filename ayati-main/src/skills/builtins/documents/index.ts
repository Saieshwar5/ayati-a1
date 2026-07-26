import type { PreparedAttachmentService } from "../../../documents/prepared-attachment-service.js";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

export interface DocumentSkillDeps {
  preparedAttachmentService: PreparedAttachmentService;
}

function buildSuccessResult(output: Record<string, unknown>, meta?: Record<string, unknown>): ToolResult {
  return {
    ok: true,
    output: JSON.stringify(output, null, 2),
    ...(meta ? { meta } : {}),
  };
}

function buildFailureResult(error: string): ToolResult {
  return {
    ok: false,
    error,
  };
}

function createDocumentListSectionsTool(deps: DocumentSkillDeps): ToolDefinition {
  return {
    name: "document_list_sections",
    description: "List available section or page handles for a prepared text attachment.",
    inputSchema: {
      type: "object",
      properties: {
        preparedInputId: { type: "string", description: "Prepared unstructured attachment reference. Use the preparedInputId when known; the display name also works." },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      const preparedInputId = readOptionalString(input, "preparedInputId");
      const runId = readRunId(context);
      try {
        return buildSuccessResult(await deps.preparedAttachmentService.listDocumentSections(runId, preparedInputId));
      } catch (err) {
        return buildFailureResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createDocumentReadSectionTool(deps: DocumentSkillDeps): ToolDefinition {
  return {
    name: "document_read_section",
    description: "Read exact text for one or more prepared document sections.",
    inputSchema: {
      type: "object",
      required: ["sectionIds"],
      properties: {
        preparedInputId: { type: "string", description: "Prepared unstructured attachment reference. Use the preparedInputId when known; the display name also works." },
        sectionIds: {
          type: "array",
          items: { type: "string" },
          description: "One or more section ids returned by document_list_sections.",
        },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      const preparedInputId = readOptionalString(input, "preparedInputId");
      const sectionIds = readRequiredStringArray(input, "sectionIds");
      const runId = readRunId(context);
      try {
        return buildSuccessResult(await deps.preparedAttachmentService.readDocumentSections({
          runId,
          preparedInputId,
          sectionIds,
        }));
      } catch (err) {
        return buildFailureResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createDocumentQueryTool(deps: DocumentSkillDeps): ToolDefinition {
  return {
    name: "document_query",
    description: "Answer a semantic question over a prepared text attachment with grounded retrieval output.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        preparedInputId: { type: "string", description: "Prepared unstructured attachment reference. Use the preparedInputId when known; the display name also works." },
        query: { type: "string", description: "Question to answer from the prepared text attachment." },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      const preparedInputId = readOptionalString(input, "preparedInputId");
      const query = readRequiredString(input, "query");
      const runId = readRunId(context);
      try {
        const output = await deps.preparedAttachmentService.queryDocument({
          runId,
          preparedInputId,
          query,
        });
        const stateUpdates = buildDocumentStateUpdates(output);
        return buildSuccessResult(output, stateUpdates.length > 0 ? { stateUpdates } : undefined);
      } catch (err) {
        return buildFailureResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createDocumentSkill(deps: DocumentSkillDeps): SkillDefinition {
  return {
    id: "documents",
    version: "1.0.0",
    description: "Prepared text attachment tools for section reads and semantic retrieval.",
    tools: [
      createDocumentListSectionsTool(deps),
      createDocumentReadSectionTool(deps),
      createDocumentQueryTool(deps),
    ],
  };
}

function readRunId(context: { runId?: string } | undefined): string {
  if (!context?.runId || context.runId.trim().length === 0) {
    throw new Error("document tools require a runId in tool execution context.");
  }
  return context.runId;
}

function readRequiredString(input: unknown, field: string): string {
  const record = isPlainObject(input) ? input : {};
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalString(input: unknown, field: string): string | undefined {
  const record = isPlainObject(input) ? input : {};
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRequiredStringArray(input: unknown, field: string): string[] {
  const record = isPlainObject(input) ? input : {};
  const value = record[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string array.`);
  }
  const normalized = value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter((entry) => entry.length > 0);
  if (normalized.length === 0) {
    throw new Error(`${field} must contain at least one non-empty string.`);
  }
  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildDocumentStateUpdates(output: Record<string, unknown>): Array<Record<string, unknown>> {
  const preparedInputId = typeof output["preparedInputId"] === "string" ? output["preparedInputId"] : "";
  if (!preparedInputId || output["indexed"] !== true) {
    return [];
  }
  return [{
    type: "mark_document_indexed",
    preparedInputId,
    indexed: true,
  }];
}
