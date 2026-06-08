import type { LearningWorkspaceController } from "../../../ui/learning-workspace.js";
import type { WorkspaceLayout, WorkspaceOrchestrator, WorkspaceWindowRole } from "../../../ui/workspace-orchestrator.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";

export interface UiSkillDeps {
  learningWorkspace: LearningWorkspaceController;
  workspaceOrchestrator: WorkspaceOrchestrator;
}

const UI_PROMPT_BLOCK = [
  "UI workspace tools are built in for the current Omarchy/Hyprland workspace anchored by the user's Ayati CLI window.",
  "Use general workspace tools for learning, coding, browsing, app previews, references, scratch explanations, and other visual work.",
  "The current CLI window is the protected anchor. You may focus, resize, and arrange it, but do not close it unless the user explicitly asks.",
  "The workspace has a hard maximum of five windows, including the CLI. Reuse same-role windows when possible; when capacity is reached, cleanup closes the least useful unpinned non-CLI window first.",
  "Prefer role-based control over raw window addresses: cli, primary, secondary, browser, code, preview, terminal, reference, scratch.",
  "Use layout presets instead of improvising geometry: 50-50 for discussion, 30-70 as the default work/learning layout, 20-80 for visual-heavy work, grid for several supporting windows, focus for one dominant surface.",
  "After calling workspace_set_layout, inspect lastActionStatus and layoutVerification. Tell the user the layout is done only when the status is applied; if it is failed, explain the measured ratio or failure reason. The 30-70 layout is the reliable agent workspace mode: protected CLI on the left and primary visual surface on the right.",
  "Do not recover from a failed workspace_set_layout by issuing raw shell hyprctl resize or move commands unless the user explicitly asks for diagnosis; the workspace tool owns layout retries and verification.",
  "Learning workspace tools still control the native Ayati Learning Workspace Tauri window. For learning tasks, show generated lessons visually instead of leaving the user in CLI-only mode.",
].join("\n");

export function createUiSkill(deps: UiSkillDeps): SkillDefinition {
  return {
    id: "ui-workspace",
    version: "1.0.0",
    description: "Scoped OS/window control for Ayati-owned visual workspaces.",
    promptBlock: UI_PROMPT_BLOCK,
    tools: [
      createOpenLearningWorkspaceTool(deps),
      createFocusLearningWorkspaceTool(deps),
      createShowLearningCourseTool(deps),
      createShowLearningLessonTool(deps),
      createGetLearningWorkspaceStateTool(deps),
      createCloseLearningWorkspaceTool(deps),
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

function createOpenLearningWorkspaceTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "ui_open_learning_workspace",
    description: "Open the Ayati Learning Workspace Tauri window and optionally show a course or lesson.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "Optional course id to show." },
        lessonId: { type: "string", description: "Optional lesson id to show." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["ui", "window", "learning", "open"],
      domain: "ui",
      priority: 100,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.learningWorkspace.open({
          clientId: clientIdFromContext(context),
          courseId: readOptionalString(value, "courseId"),
          lessonId: readOptionalString(value, "lessonId"),
          uiContext: context?.uiContext,
        });
      });
    },
  };
}

function createFocusLearningWorkspaceTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "ui_focus_learning_workspace",
    description: "Ask the Ayati Learning Workspace window to focus itself.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["ui", "window", "learning", "focus"],
      domain: "ui",
      priority: 90,
    },
    async execute(_input, context): Promise<ToolResult> {
      return withJsonResult(async () => deps.learningWorkspace.focus(clientIdFromContext(context), context?.uiContext));
    },
  };
}

function createShowLearningCourseTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "ui_show_learning_course",
    description: "Show a course dashboard in the Ayati Learning Workspace window.",
    inputSchema: {
      type: "object",
      required: ["courseId"],
      properties: {
        courseId: { type: "string", description: "Course id to show." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["ui", "window", "learning", "course"],
      domain: "ui",
      priority: 95,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.learningWorkspace.showCourse({
          clientId: clientIdFromContext(context),
          courseId: readRequiredString(value, "courseId"),
          uiContext: context?.uiContext,
        });
      });
    },
  };
}

function createShowLearningLessonTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "ui_show_learning_lesson",
    description: "Show a specific course lesson in the Ayati Learning Workspace window.",
    inputSchema: {
      type: "object",
      required: ["courseId", "lessonId"],
      properties: {
        courseId: { type: "string", description: "Course id to show." },
        lessonId: { type: "string", description: "Lesson id to show." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["ui", "window", "learning", "lesson"],
      domain: "ui",
      priority: 100,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.learningWorkspace.showLesson({
          clientId: clientIdFromContext(context),
          courseId: readRequiredString(value, "courseId"),
          lessonId: readRequiredString(value, "lessonId"),
          uiContext: context?.uiContext,
        });
      });
    },
  };
}

function createGetLearningWorkspaceStateTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "ui_get_learning_workspace_state",
    description: "Read the current Ayati Learning Workspace state.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["ui", "window", "learning", "state"],
      domain: "ui",
      priority: 80,
    },
    async execute(_input, context): Promise<ToolResult> {
      return withJsonResult(async () => deps.learningWorkspace.getState(clientIdFromContext(context)));
    },
  };
}

function createCloseLearningWorkspaceTool(deps: UiSkillDeps): ToolDefinition {
  return {
    name: "ui_close_learning_workspace",
    description: "Close the Ayati Learning Workspace window when it was launched by the backend.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["ui", "window", "learning", "close"],
      domain: "ui",
      priority: 75,
    },
    async execute(_input, context): Promise<ToolResult> {
      return withJsonResult(async () => deps.learningWorkspace.close(clientIdFromContext(context)));
    },
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
    selectionHints: {
      tags: ["workspace", "hyprland", "state", "windows"],
      domain: "ui",
      priority: 115,
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
    selectionHints: {
      tags: ["workspace", "layout", "hyprland", "arrange", "50-50", "30-70", "20-80"],
      domain: "ui",
      priority: 125,
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
    selectionHints: {
      tags: ["workspace", "focus", "window", "hyprland"],
      domain: "ui",
      priority: 110,
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
    selectionHints: {
      tags: ["workspace", "role", "register", "window"],
      domain: "ui",
      priority: 100,
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
    selectionHints: {
      tags: ["workspace", "open", "reuse", "window", "capacity", "lru"],
      domain: "ui",
      priority: 120,
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
    selectionHints: {
      tags: ["workspace", "close", "window", "cleanup"],
      domain: "ui",
      priority: 95,
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
    selectionHints: {
      tags: ["workspace", "cleanup", "lru", "max windows"],
      domain: "ui",
      priority: 100,
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
