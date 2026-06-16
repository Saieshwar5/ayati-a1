import type { RestoredAttachmentContext, SessionAttachmentService } from "../../../documents/session-attachment-service.js";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

export interface AttachmentSkillDeps {
  sessionAttachmentService: SessionAttachmentService;
}

const ATTACHMENT_PROMPT_BLOCK = [
  "Unified attachment restoration is built in.",
  "Use attachment_restore when the user refers to a file, document, dataset, or directory stored on a focus card.",
  "For follow-up work, call focus_activate first, then call attachment_restore with no input when the focus has exactly one restorable asset, or with assetId/reference when it has multiple.",
  "If the current run already has attached files, do not restore an older attachment unless the user explicitly asks for the earlier one.",
  "Inputs accept focusId, assetId, or a reference such as preparedInputId, fileId, directoryId, display name, or path.",
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

function createRestoreAttachmentContextTool(deps: AttachmentSkillDeps, name = "attachment_restore"): ToolDefinition {
  return {
    name,
    description: "Restore a previously used file, directory, document, or dataset attachment into the current run.",
    inputSchema: {
      type: "object",
      properties: {
        focusId: {
          type: "string",
          description: "Optional focus card id to restore from. If omitted, the currently activated focus card for this session is used.",
        },
        assetId: {
          type: "string",
          description: "Optional focus asset id to restore.",
        },
        reference: {
          type: "string",
          description: "Optional focus asset reference. Use display name, preparedInputId, fileId, directoryId, documentId, assetId, or path when known.",
        },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["attachments", "restore", "followup"],
      domain: "attachments",
      priority: name === "attachment_restore" ? 100 : 85,
    },
    async execute(input, context): Promise<ToolResult> {
      const runId = readRunId(context);
      const clientId = readContextString(context, "clientId");
      const sessionId = readContextString(context, "sessionId");
      const focusId = readOptionalString(input, "focusId");
      const assetId = readOptionalString(input, "assetId");
      const reference = readOptionalString(input, "reference");
      try {
        const restored = await deps.sessionAttachmentService.restoreAttachmentContext({
          runId,
          clientId,
          sessionId,
          focusId,
          assetId,
          reference,
        });
        const stateUpdates = buildRestoreStateUpdates(restored);
        return buildSuccessResult(buildRestoreOutput(restored), stateUpdates.length > 0 ? { stateUpdates } : undefined);
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
    description: "Restore previously used attachments from active focus context into the current run.",
    promptBlock: ATTACHMENT_PROMPT_BLOCK,
    tools: [
      createRestoreAttachmentContextTool(deps),
      createRestoreAttachmentContextTool(deps, "restore_attachment_context"),
    ],
  };
}

function buildRestoreOutput(restored: RestoredAttachmentContext): Record<string, unknown> {
  if (restored.attachmentKind === "file") {
    return {
      restored: restored.restored,
      attachmentKind: restored.attachmentKind,
      focusId: restored.focusId,
      assetId: restored.assetId,
      attachmentId: restored.fileId,
      fileId: restored.fileId,
      displayName: restored.displayName,
      kind: restored.kind,
      mode: "file",
    };
  }
  if (restored.attachmentKind === "directory") {
    return {
      restored: restored.restored,
      attachmentKind: restored.attachmentKind,
      focusId: restored.focusId,
      assetId: restored.assetId,
      attachmentId: restored.directoryId,
      directoryId: restored.directoryId,
      displayName: restored.displayName,
      kind: restored.kind,
      mode: "directory",
    };
  }
  return {
    restored: restored.restored,
    attachmentKind: restored.attachmentKind,
    focusId: restored.focusId,
    assetId: restored.assetId,
    attachmentId: restored.summary.preparedInputId,
    preparedInputId: restored.summary.preparedInputId,
    documentId: restored.summary.documentId,
    displayName: restored.summary.displayName,
    kind: restored.summary.kind,
    mode: restored.summary.mode,
  };
}

function buildRestoreStateUpdates(restored: RestoredAttachmentContext): Array<Record<string, unknown>> {
  if (restored.attachmentKind === "file") {
    return [{ type: "restore_managed_file", fileId: restored.fileId }];
  }
  if (restored.attachmentKind === "directory") {
    return [{ type: "restore_managed_directory", directoryId: restored.directoryId }];
  }
  return [{
    type: "restore_prepared_attachment",
    manifest: restored.manifest,
    summary: restored.summary,
  }];
}

function readRunId(context: { runId?: string } | undefined): string {
  if (!context?.runId || context.runId.trim().length === 0) {
    throw new Error("attachment restore requires a runId in tool execution context.");
  }
  return context.runId;
}

function readContextString(
  context: { clientId?: string; sessionId?: string } | undefined,
  field: "clientId" | "sessionId",
): string | undefined {
  const value = context?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalString(input: unknown, field: string): string | undefined {
  const record = isPlainObject(input) ? input : {};
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
