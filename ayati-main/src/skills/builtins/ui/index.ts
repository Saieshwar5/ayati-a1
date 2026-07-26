import type { WorkspaceLayout, WorkspaceOrchestrator, WorkspaceWindowRole } from "../../../ui/workspace-orchestrator.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";

export interface UiSkillDeps {
  workspaceOrchestrator: WorkspaceOrchestrator;
}

export function createUiSkill(deps: UiSkillDeps): SkillDefinition {
  return {
    id: "ui-workspace",
    version: "1.0.0",
    description: "Scoped OS/window control for Ayati-owned visual workspaces.",
    tools: [
      createWorkspaceGetStateTool(deps),
      createWorkspaceSetLayoutTool(deps),
      createWorkspaceFocusWindowTool(deps),
      createWorkspaceRegisterWindowTool(deps),
      createWorkspaceReuseOrOpenWindowTool(deps),
      createWorkspaceCloseWindowTool(deps),
      createWorkspaceCleanupUnusedTool(deps),
    ],
  };
}

function createWorkspaceGetStateTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "workspace_get_state",
    description: "Read the current CLI-anchored Omarchy/Hyprland workspace state, including roles, layout, max window policy, and known windows.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_input, context): Promise<ToolResult> {
      return withJsonResult(async () => deps.workspaceOrchestrator.getState({
        clientId: clientIdFromContext(context),
        uiContext: context?.uiContext,
      }));
    },
  };
}

function createWorkspaceSetLayoutTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "workspace_set_layout",
    description: "Apply a preset layout in the current CLI workspace. Prefer 30-70 for the reliable agent workspace mode: protected CLI on the left, primary visual surface on the right.",
    inputSchema: {
      type: "object",
      required: ["layout"],
      properties: {
        layout: layoutSchema(),
        primaryRole: roleSchema("Optional role to use as the primary non-CLI surface."),
        primaryAddress: { type: "string", description: "Optional exact Hyprland window address to use as primary." },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.workspaceOrchestrator.setLayout({
          clientId: clientIdFromContext(context),
          uiContext: context?.uiContext,
          layout: readLayout(value, "layout"),
          primaryRole: readOptionalRole(value, "primaryRole"),
          primaryAddress: readOptionalString(value, "primaryAddress"),
        });
      });
    },
  };
}

function createWorkspaceFocusWindowTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "workspace_focus_window",
    description: "Focus a window in the current CLI workspace by role or exact Hyprland address.",
    inputSchema: {
      type: "object",
      properties: {
        role: roleSchema("Window role to focus."),
        address: { type: "string", description: "Exact Hyprland window address to focus." },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.workspaceOrchestrator.focusWindow({
          clientId: clientIdFromContext(context),
          uiContext: context?.uiContext,
          role: readOptionalRole(value, "role"),
          address: readOptionalString(value, "address"),
        });
      });
    },
  };
}

function createWorkspaceRegisterWindowTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "workspace_register_window",
    description: "Assign or update an explicit role/policy for a window in the current CLI workspace.",
    inputSchema: {
      type: "object",
      required: ["address", "role"],
      properties: {
        address: { type: "string", description: "Exact Hyprland window address." },
        role: roleSchema("Role to assign to this window."),
        ownedByAyati: { type: "boolean", description: "Whether Ayati may reuse/close this window automatically." },
        pinned: { type: "boolean", description: "Pinned windows are protected from automatic cleanup." },
        contentHint: { type: "string", description: "Short note about what this window is currently showing." },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.workspaceOrchestrator.registerWindow({
          clientId: clientIdFromContext(context),
          uiContext: context?.uiContext,
          address: readRequiredString(value, "address"),
          role: readRole(value, "role"),
          ownedByAyati: readOptionalBoolean(value, "ownedByAyati"),
          pinned: readOptionalBoolean(value, "pinned"),
          contentHint: readOptionalString(value, "contentHint"),
        });
      });
    },
  };
}

function createWorkspaceReuseOrOpenWindowTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "workspace_reuse_or_open_window",
    description: "Reuse an existing same-role workspace window or open a new command-backed window, cleaning up least-used windows at capacity.",
    inputSchema: {
      type: "object",
      required: ["role"],
      properties: {
        role: roleSchema("Desired window role."),
        command: { type: "string", description: "Shell command to launch when no reusable role window exists." },
        reuse: { type: "boolean", description: "Reuse an existing same-role window when possible. Defaults to true." },
        titleHint: { type: "string", description: "Optional title substring used to identify the launched window." },
        classHint: { type: "string", description: "Optional class substring used to identify the launched window." },
        contentHint: { type: "string", description: "Short note about what this window will show." },
        pinned: { type: "boolean", description: "Protect this window from automatic cleanup." },
        ownedByAyati: { type: "boolean", description: "Whether Ayati may reuse/close this window automatically. Defaults true for launched windows." },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.workspaceOrchestrator.reuseOrOpenWindow({
          clientId: clientIdFromContext(context),
          uiContext: context?.uiContext,
          role: readRole(value, "role"),
          command: readOptionalString(value, "command"),
          reuse: readOptionalBoolean(value, "reuse"),
          titleHint: readOptionalString(value, "titleHint"),
          classHint: readOptionalString(value, "classHint"),
          contentHint: readOptionalString(value, "contentHint"),
          pinned: readOptionalBoolean(value, "pinned"),
          ownedByAyati: readOptionalBoolean(value, "ownedByAyati"),
        });
      });
    },
  };
}

function createWorkspaceCloseWindowTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "workspace_close_window",
    description: "Close a window in the current CLI workspace by role or address. The anchor CLI is protected unless allowClosingAnchor is true.",
    inputSchema: {
      type: "object",
      properties: {
        role: roleSchema("Window role to close."),
        address: { type: "string", description: "Exact Hyprland window address to close." },
        allowClosingAnchor: { type: "boolean", description: "Allow closing the protected CLI anchor. Defaults to false." },
      },
      additionalProperties: false,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.workspaceOrchestrator.closeWindow({
          clientId: clientIdFromContext(context),
          uiContext: context?.uiContext,
          role: readOptionalRole(value, "role"),
          address: readOptionalString(value, "address"),
          allowClosingAnchor: readOptionalBoolean(value, "allowClosingAnchor"),
        });
      });
    },
  };
}

function createWorkspaceCleanupUnusedTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "workspace_cleanup_unused",
    description: "Enforce the max-five-window policy by closing least-useful unpinned non-CLI windows in the current workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_input, context): Promise<ToolResult> {
      return withJsonResult(async () => deps.workspaceOrchestrator.cleanupUnused({
        clientId: clientIdFromContext(context),
        uiContext: context?.uiContext,
      }));
    },
  };
}

async function withJsonResult(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { ok: true, output: JSON.stringify(await fn(), null, 2) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readRequiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

function readLayout(record: Record<string, unknown>, field: string): WorkspaceLayout {
  const value = record[field];
  if (value === "50-50" || value === "30-70" || value === "20-80" || value === "grid" || value === "focus") {
    return value;
  }
  throw new Error(`${field} must be one of 50-50, 30-70, 20-80, grid, or focus.`);
}

function readRole(record: Record<string, unknown>, field: string): WorkspaceWindowRole {
  const value = readOptionalRole(record, field);
  if (!value) {
    throw new Error(`${field} must be a valid workspace window role.`);
  }
  return value;
}

function readOptionalRole(record: Record<string, unknown>, field: string): WorkspaceWindowRole | undefined {
  const value = record[field];
  return value === "cli"
    || value === "primary"
    || value === "secondary"
    || value === "browser"
    || value === "code"
    || value === "preview"
    || value === "terminal"
    || value === "reference"
    || value === "scratch"
    ? value
    : undefined;
}

function layoutSchema(): Record<string, unknown> {
  return {
    type: "string",
    enum: ["50-50", "30-70", "20-80", "grid", "focus"],
    description: "Workspace layout preset.",
  };
}

function roleSchema(description: string): Record<string, unknown> {
  return {
    type: "string",
    enum: ["cli", "primary", "secondary", "browser", "code", "preview", "terminal", "reference", "scratch"],
    description,
  };
}

function clientIdFromContext(context: ToolExecutionContext | undefined): string {
  return context?.clientId?.trim() || "local";
}
