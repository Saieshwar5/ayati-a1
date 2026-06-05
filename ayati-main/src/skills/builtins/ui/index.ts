import type { LearningWorkspaceController } from "../../../ui/learning-workspace.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";

export interface UiSkillDeps {
  learningWorkspace: LearningWorkspaceController;
}

const UI_PROMPT_BLOCK = [
  "UI workspace tools are built in for Ayati-owned windows.",
  "Use these tools only to control the native Ayati Learning Workspace Tauri window.",
  "Allowed: open, focus, show a course, show a lesson, read state, and close the learning workspace.",
  "Do not use these tools as permission to control arbitrary user apps or unrelated OS windows.",
  "For learning tasks, show generated lessons in the native visual workspace instead of leaving the user in CLI-only mode.",
  "Browser URLs are debug fallbacks only; normal learning should render in the Tauri workspace.",
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

function clientIdFromContext(context: ToolExecutionContext | undefined): string {
  return context?.clientId?.trim() || "local";
}
