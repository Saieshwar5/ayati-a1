import type { ToolResult } from "../skills/types.js";
import type { LlmToolSchema } from "../core/contracts/llm-protocol.js";

export const CREATE_SESSION_TOOL_NAME = "create_session";
export const TASK_CONTROL_TOOL_NAME = "task_control";

export const TASK_CONTROL_TOOL_SCHEMA: LlmToolSchema = {
  name: TASK_CONTROL_TOOL_NAME,
  description:
    "Manage long-running Tier 3 tasks that span multiple sessions. " +
    "Use action='start' to begin a multi-session task (declare goal + subtasks). " +
    "Use action='complete_subtask' after finishing a subtask — write notes to data/tasks/{taskId}/subtasks/{id}-notes.md FIRST. " +
    "Use action='finish' when all subtasks are done and you have the final answer.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        description: "One of: 'start' | 'complete_subtask' | 'finish'",
      },
      goal: {
        type: "string",
        description: "Required for action='start'. Single sentence describing the full task goal.",
      },
      subtasks: {
        type: "array",
        description: "Required for action='start'. Array of subtask objects.",
        items: {
          type: "object",
          required: ["id", "title"],
          properties: {
            id: { type: "number", description: "Unique subtask ID starting from 1." },
            title: { type: "string", description: "Short description of what this subtask does." },
            depends_on: { type: "array", items: { type: "number" }, description: "IDs of subtasks that must complete first." },
          },
        },
      },
      task_id: {
        type: "string",
        description: "Required for action='complete_subtask' and 'finish'. The task ID from start.",
      },
      subtask_id: {
        type: "number",
        description: "Required for action='complete_subtask'. The subtask ID just completed.",
      },
      handoff: {
        type: "string",
        description: "Required for action='complete_subtask'. 2-3 sentences: what was done, key finding, what comes next.",
      },
      summary: {
        type: "string",
        description: "Required for action='finish'. The complete final answer for the user.",
      },
    },
  },
};

export const CREATE_SESSION_TOOL_SCHEMA: LlmToolSchema = {
  name: CREATE_SESSION_TOOL_NAME,
  description: "Create a new session when the user's goal has shifted or context % is high and you are at a natural stopping point. Working memory state (plan, key facts, steps) is auto-attached — do not duplicate it.",
  inputSchema: {
    type: "object",
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        description: "Short reason describing why this request should start a new session.",
      },
      confidence: {
        type: "number",
        description: "Optional confidence from 0.0 to 1.0 for the session switch decision.",
      },
      handoff_summary: {
        type: "string",
        description: "Describe what was accomplished, what is still pending, and any important decisions. Be concrete. Working memory is auto-attached so focus on intent and context, not technical state.",
      },
    },
  },
};

export function formatToolResult(toolName: string, result: ToolResult): string {
  return JSON.stringify(
    {
      tool: toolName,
      ok: result.ok,
      output: result.output ?? "",
      error: result.error ?? "",
      meta: result.meta ?? {},
    },
    null,
    2,
  );
}

export function formatValidationError(
  toolName: string,
  validationError: string,
  schema?: Record<string, unknown>,
): string {
  const lines: string[] = [
    `Tool '${toolName}' input validation failed: ${validationError}`,
  ];

  if (schema) {
    const properties = schema["properties"] as Record<string, unknown> | undefined;
    const required = schema["required"] as string[] | undefined;

    if (properties) {
      lines.push("");
      lines.push(`Required schema for '${toolName}':`);
      lines.push(JSON.stringify(properties, null, 2));
    }

    if (required && required.length > 0) {
      lines.push("");
      lines.push(`Required fields: ${required.join(", ")}`);
    }
  }

  return lines.join("\n");
}
