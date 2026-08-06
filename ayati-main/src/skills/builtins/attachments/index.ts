import type { RestoredAttachmentContext, SessionAttachmentService } from "../../../files/session-attachment-service.js";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

export interface AttachmentSkillDeps {
  sessionAttachmentService: SessionAttachmentService;
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

function createRestoreAttachmentContextTool(deps: AttachmentSkillDeps): ToolDefinition {
  return {
    name: "attachment_restore",
    description: "Restore a previously used file, directory, document, or dataset attachment into the current run.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: {
          type: "string",
          description: "Optional workstream resource id to restore.",
        },
        reference: {
          type: "string",
          description: "Optional workstream resource reference. Use display name, alias, resource id, file path, or directory path when known.",
        },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      const runId = readRunId(context);
      const resourceId = readOptionalString(input, "resourceId");
      const reference = readOptionalString(input, "reference");
      try {
        const restored = await deps.sessionAttachmentService.restoreAttachmentContext({
          runId,
          resourceId,
          reference,
          workstreamResources: context?.workstreamResources,
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
    description: "Restore a bound workstream resource into the current run's attachment tools.",
    tools: [
      createRestoreAttachmentContextTool(deps),
    ],
  };
}

function buildRestoreOutput(restored: RestoredAttachmentContext): Record<string, unknown> {
  if (restored.attachmentKind === "file") {
    return {
      restored: restored.restored,
      attachmentKind: restored.attachmentKind,
      resourceId: restored.resourceId,
      attachmentId: restored.fileId,
      fileId: restored.fileId,
      path: restored.path,
      displayName: restored.displayName,
      kind: restored.kind,
      mode: "file",
    };
  }
  return {
    restored: restored.restored,
    attachmentKind: restored.attachmentKind,
    resourceId: restored.resourceId,
    attachmentId: restored.directoryId,
    directoryId: restored.directoryId,
    path: restored.path,
    displayName: restored.displayName,
    kind: restored.kind,
    mode: "directory",
  };
}

function buildRestoreStateUpdates(restored: RestoredAttachmentContext): Array<Record<string, unknown>> {
  if (restored.attachmentKind === "file") {
    return [{ type: "restore_managed_file", fileId: restored.fileId }];
  }
  return [{ type: "restore_managed_directory", directoryId: restored.directoryId }];
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
