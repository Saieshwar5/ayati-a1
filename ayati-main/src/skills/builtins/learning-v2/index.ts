import type { LearningFileStore } from "../../../learning/file-store.js";
import type { LearningWorkspaceController } from "../../../ui/learning-workspace.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";

export interface LearningFileSkillDeps {
  learningFileStore: LearningFileStore;
  learningWorkspace?: LearningWorkspaceController;
}

const LEARNING_FILE_PROMPT_BLOCK = [
  "Learning V2 is filesystem-native.",
  "Use learning_status to discover the learning root, active interest, protocol file, preferences file, and exact absolute paths.",
  "Use normal filesystem tools to create interests, update course.md, update index.md, write feedback.md, append log.md, and create lesson.md/view.html/style.css/script.js files.",
  "A learning interest is not a traditional course. It is a durable thread for anything the user wants to learn.",
  "Do not generate a full syllabus up front. Create one next lesson at a time.",
  "Write lesson.md first, then render view.html/style.css/script.js from it.",
  "Lessons must be curiosity-driven and first-principles based: start at the surface, raise one strong question, descend step by step, end with new questions.",
  "Visual lessons must be responsive. The lesson content comes first; navigation must collapse into a drawer or menu on narrow surfaces.",
  "Use learning_workspace_show only after a view.html exists and the user should see it visually.",
].join("\n");

export function createLearningFileSkill(deps: LearningFileSkillDeps): SkillDefinition {
  return {
    id: "learning-v2",
    version: "2.0.0",
    description: "Filesystem-native learning threads with compact context and visual lesson display.",
    promptBlock: LEARNING_FILE_PROMPT_BLOCK,
    tools: [
      createLearningStatusTool(deps),
      createLearningWorkspaceShowTool(deps),
    ],
  };
}

function createLearningStatusTool(deps: LearningFileSkillDeps): ToolDefinition {
  return {
    name: "learning_status",
    description: "Return Learning V2 filesystem status, active interest, protocol paths, and exact files the agent should read or edit.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "filesystem", "status", "course", "interest"],
      domain: "learning",
      priority: 120,
    },
    async execute(): Promise<ToolResult> {
      return withJsonResult(async () => deps.learningFileStore.getStatus());
    },
  };
}

function createLearningWorkspaceShowTool(deps: LearningFileSkillDeps): ToolDefinition {
  return {
    name: "learning_workspace_show",
    description: "Open or focus the visual learning workspace for a Learning V2 interest lesson after view.html has been written.",
    inputSchema: {
      type: "object",
      properties: {
        interestId: {
          type: "string",
          description: "Optional interest id. Defaults to system/active.json activeInterestId.",
        },
        lessonId: {
          type: "string",
          description: "Optional lesson directory id under interests/<id>/lessons/.",
        },
        viewPath: {
          type: "string",
          description: "Optional absolute path or learning-root-relative path to view.html.",
        },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "workspace", "visual", "lesson", "html"],
      domain: "learning",
      priority: 105,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const status = await deps.learningFileStore.markLearningTurn({
          interestId: readOptionalString(value, "interestId"),
          lessonId: readOptionalString(value, "lessonId"),
          viewPath: readOptionalString(value, "viewPath"),
        });
        if (!deps.learningWorkspace) {
          return {
            status,
            workspace: { opened: false, reason: "learning workspace controller is not configured" },
          };
        }

        const activeInterestId = status.activeState.activeInterestId;
        const activeLessonId = status.activeState.activeLessonId;
        const workspace = await deps.learningWorkspace.open({
          clientId: clientIdFromContext(context),
          courseId: activeInterestId,
          interestId: activeInterestId,
          lessonId: activeLessonId,
          viewPath: status.activeState.activeViewPath,
          learningVersion: "v2",
          uiContext: context?.uiContext,
        });
        return { status, workspace };
      });
    },
  };
}

async function withJsonResult(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const output = await fn();
    return { ok: true, output: JSON.stringify(output, null, 2) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function clientIdFromContext(context: ToolExecutionContext | undefined): string {
  return context?.clientId?.trim() || "local";
}
