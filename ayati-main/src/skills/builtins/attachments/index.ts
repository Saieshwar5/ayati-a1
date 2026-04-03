import type { SessionAttachmentService } from "../../../documents/session-attachment-service.js";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

export interface AttachmentSkillDeps {
  sessionAttachmentService: SessionAttachmentService;
}

const ATTACHMENT_PROMPT_BLOCK = [
  "Active session attachment restoration is built in.",
  "Use restore_attachment_context when the user refers to a file from earlier in the same session and no current attachment is available.",
  "If the current run already has attached or prepared files, do not restore an older session attachment unless the user explicitly asks for the earlier file.",
  "Inputs accept a prior attachment reference: preparedInputId is preferred, but the display name also works.",
  "If exactly one active session attachment exists, restore_attachment_context can auto-select it.",
].join("\n");

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

function createRestoreAttachmentContextTool(deps: AttachmentSkillDeps): ToolDefinition {
  return {
    name: "restore_attachment_context",
    description: "Restore a previously used attachment from the active session into the current run so normal document or dataset tools can use it.",
    inputSchema: {
      type: "object",
      properties: {
        reference: {
          type: "string",
          description: "Optional active attachment reference. Use the display name or preparedInputId when known.",
        },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["attachments", "restore", "followup"],
      domain: "attachments",
      priority: 95,
    },
    async execute(input, context): Promise<ToolResult> {
      const runId = readRunId(context);
      const reference = readOptionalString(input, "reference");
      try {
        const restored = await deps.sessionAttachmentService.restoreAttachmentContext({ runId, reference });
        const stateUpdates = restored.restored
          ? [{ type: "restore_prepared_attachment", manifest: restored.manifest, summary: restored.summary }]
          : [];
        return buildSuccessResult({
          restored: restored.restored,
          preparedInputId: restored.summary.preparedInputId,
          displayName: restored.summary.displayName,
          kind: restored.summary.kind,
          mode: restored.summary.mode,
        }, stateUpdates.length > 0 ? { stateUpdates } : undefined);
      } catch (err) {
        return buildFailureResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createAttachmentSkill(deps: AttachmentSkillDeps): SkillDefinition {
  return {
    id: "attachments",
    version: "1.0.0",
    description: "Restore previously used attachments from the active session into the current run.",
    promptBlock: ATTACHMENT_PROMPT_BLOCK,
    tools: [createRestoreAttachmentContextTool(deps)],
  };
}

function readRunId(context: { runId?: string } | undefined): string {
  if (!context?.runId || context.runId.trim().length === 0) {
    throw new Error("attachment restore requires a runId in tool execution context.");
  }
  return context.runId;
}

function readOptionalString(input: unknown, field: string): string | undefined {
  const record = isPlainObject(input) ? input : {};
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
