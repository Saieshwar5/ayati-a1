import { randomUUID } from "node:crypto";
import type { GitContextService, RunWorkStateInput } from "ayati-git-context";
import { buildContextEngineProjection } from "../../../context-engine/index.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";
import {
  parseTaskPlacement,
  resolveTaskPlacement,
  type TaskPlacementInput,
} from "./task-placement.js";

export interface GitContextSkillDeps {
  service: GitContextService;
  workspaceRoot: string;
}

const PROMPT = [
  "Tasks are long-lived workstreams stored in independent Git repositories with one stable working directory.",
  "A request is one bounded feature, lesson, analysis, or improvement inside a task; a run is only the current attempt.",
  "Continue the current request only when the user is still pursuing its unfinished outcome. A materially separate outcome belongs to a new request in the same task, not automatically to a new task.",
  "Completing one request does not complete or archive its task. A task may remain active with no current request.",
  "There is no session-global active task. Each task run owns exactly one task.",
  "The current context includes recent task candidates. Resource ownership and existing task files are stronger routing signals than text similarity.",
  "Use git_context_activate_task when the request continues or changes an existing task.",
  "Use git_context_create_task only when the request starts a distinct durable deliverable.",
  "Never default an unclear mutation to the most recent task. Ask the user when ownership remains ambiguous.",
  "Every new task must declare placement explicitly: requested or managed.",
  "For requested placement, provide the absolute directory that will contain the deliverables as workingDirectory. If the user names an output file, use its parent directory.",
  "Use managed placement only when no requested location exists. Never silently replace a requested location with a managed directory.",
  "After either tool succeeds, use absolute paths rooted inside the returned workingDirectory for every host filesystem tool call.",
].join("\n");

export function createGitContextSkill(deps: GitContextSkillDeps): SkillDefinition {
  return {
    id: "git-context",
    version: "2.0.0",
    description: "Select exactly one durable Git task repository before mutation.",
    promptBlock: PROMPT,
    tools: [
      createTaskTool(deps),
      activateTaskTool(deps.service),
    ],
  };
}

function createTaskTool(deps: GitContextSkillDeps): ToolDefinition {
  const service = deps.service;
  return {
    name: "git_context_create_task",
    description: "Create a distinct durable task repository in the requested or managed working directory, register its session pointer, and start its task run.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short durable task title." },
        objective: { type: "string", description: "Concrete deliverable or durable objective." },
        placement: {
          type: "object",
          description: "Explicit placement decision. Use requested with an absolute workingDirectory when the user message or verified read context specifies a location. If the user specifies an output file, use its parent directory. Use managed only when no location was requested.",
          properties: {
            mode: { enum: ["requested", "managed"] },
            workingDirectory: { type: "string", description: "Absolute directory that will contain task deliverables. This must be a directory, not an output file path. Omit for managed mode." },
          },
          required: ["mode"],
          additionalProperties: false,
          anyOf: [
            {
              properties: { mode: { const: "requested" }, workingDirectory: { type: "string" } },
              required: ["mode", "workingDirectory"],
            },
            {
              properties: { mode: { const: "managed" } },
              required: ["mode"],
            },
          ],
        },
        reason: { type: "string", description: "Why this request is a new task instead of an existing task." },
      },
      required: ["title", "objective", "placement", "reason"],
      additionalProperties: false,
    },
    outputSchema: routingOutputSchema(),
    annotations: routingAnnotations(),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "task", "create", "routing"],
      aliases: ["create task", "start new durable work"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseCreateInput(input, context);
      if ("ok" in parsed) return parsed;
      try {
        const active = await service.getActiveContext({ sessionId: parsed.sessionId });
        const conversation = active.session?.pendingConversationContext.at(-1)?.conversation;
        if (!conversation || conversation.status !== "active") {
          return routingError("No active conversation exists for task creation.");
        }
        const placement = resolveTaskPlacement(parsed.placement, active, deps.workspaceRoot);
        if (!placement.ok) {
          return routingError(placement.message);
        }
        const selected = await service.createTaskRun({
          requestId: randomUUID(),
          sessionId: parsed.sessionId,
          conversationId: conversation.conversationId,
          ...(active.run?.run.runId ? { runId: active.run.run.runId } : {}),
          trigger: conversationTrigger(active, conversation.conversationId),
          workState: active.run?.workState ?? initialWorkState(),
          title: parsed.title,
          objective: parsed.objective,
          placement: placement.placement,
          at: new Date().toISOString(),
        });
        return routingSuccess(service, parsed.sessionId, selected.task.taskId, selected.run.runId, "created");
      } catch (error) {
        return routingError(errorMessage(error));
      }
    },
  };
}

function activateTaskTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_activate_task",
    description: "Mount an existing durable task repository and start or promote the current run for it.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", pattern: "^W-[0-9]{8}-[0-9]{4}$", description: "Exact task id from current task candidates." },
        reason: { type: "string", description: "Why the current request belongs to this task and its resources." },
      },
      required: ["taskId", "reason"],
      additionalProperties: false,
    },
    outputSchema: routingOutputSchema(),
    annotations: routingAnnotations(),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "task", "activate", "routing"],
      aliases: ["activate task", "continue existing task", "switch task"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseActivateInput(input, context);
      if ("ok" in parsed) return parsed;
      try {
        const active = await service.getActiveContext({ sessionId: parsed.sessionId });
        const conversation = active.session?.pendingConversationContext.at(-1)?.conversation;
        if (!conversation || conversation.status !== "active") {
          return routingError("No active conversation exists for task activation.");
        }
        const selected = await service.activateTaskRun({
          requestId: randomUUID(),
          sessionId: parsed.sessionId,
          conversationId: conversation.conversationId,
          ...(active.run?.run.runId ? { runId: active.run.run.runId } : {}),
          trigger: conversationTrigger(active, conversation.conversationId),
          workState: active.run?.workState ?? initialWorkState(),
          taskId: parsed.taskId,
          at: new Date().toISOString(),
        });
        return routingSuccess(service, parsed.sessionId, selected.task.taskId, selected.run.runId, "activated");
      } catch (error) {
        return routingError(errorMessage(error));
      }
    },
  };
}

async function routingSuccess(
  service: GitContextService,
  sessionId: string,
  taskId: string,
  runId: string,
  mode: "created" | "activated",
): Promise<ToolResult> {
  const active = await service.getActiveContext({ sessionId });
  const task = active.activeTask;
  if (!task) return routingError("Selected task context is unavailable after activation.");
  return okJsonResult({
    code: mode === "created" ? "GIT_CONTEXT_TASK_CREATED" : "GIT_CONTEXT_TASK_ACTIVATED",
    message: mode === "created" ? "Task repository created and selected." : "Task repository selected.",
    structuredContent: {
      status: "ready",
      sessionId,
      taskId,
      branch: task.task.branch,
      mode,
      runId,
      workingDirectory: task.workingDirectory,
      harnessContext: {
        contextEngine: buildContextEngineProjection(active),
      },
    },
  });
}

function routingOutputSchema() {
  return {
    type: "object",
    properties: {
      status: { const: "ready" },
      sessionId: { type: "string" },
      taskId: { type: "string" },
      branch: { type: "string" },
      mode: { enum: ["created", "activated"] },
      runId: { type: "string" },
      workingDirectory: { type: "string" },
      harnessContext: { type: "object" },
    },
    required: ["status", "sessionId", "taskId", "branch", "mode", "runId", "workingDirectory", "harnessContext"],
    additionalProperties: false,
  };
}

function routingAnnotations() {
  return commonAnnotations({
    domain: "git_context",
    readOnly: false,
    idempotent: false,
    retrySafe: false,
  });
}

function conversationTrigger(
  active: Awaited<ReturnType<GitContextService["getActiveContext"]>>,
  conversationId: string,
): "user" | "system_event" {
  const conversation = active.session?.pendingConversationContext.find(
    (candidate) => candidate.conversation.conversationId === conversationId,
  );
  return conversation?.messages.at(-1)?.role === "system_event" ? "system_event" : "user";
}

function parseCreateInput(input: unknown, context?: ToolExecutionContext): {
  sessionId: string;
  title: string;
  objective: string;
  placement: TaskPlacementInput;
  reason: string;
} | ToolResult {
  const record = objectInput(input);
  const sessionId = context?.sessionId?.trim();
  const title = stringField(record, "title");
  const objective = stringField(record, "objective");
  const placement = parseTaskPlacement(record["placement"]);
  const reason = stringField(record, "reason");
  if (!sessionId || !title || !objective || !placement || !reason) {
    return routingError("sessionId, title, objective, placement, and reason are required.");
  }
  return { sessionId, title, objective, placement, reason };
}

function parseActivateInput(input: unknown, context?: ToolExecutionContext): {
  sessionId: string;
  taskId: string;
  reason: string;
} | ToolResult {
  const record = objectInput(input);
  const sessionId = context?.sessionId?.trim();
  const taskId = stringField(record, "taskId");
  const reason = stringField(record, "reason");
  if (!sessionId || !taskId || !/^W-\d{8}-\d{4}$/.test(taskId) || !reason) {
    return routingError("sessionId, a valid taskId, and reason are required.");
  }
  return { sessionId, taskId, reason };
}

function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function routingError(message: string): ToolResult {
  return errorResult({
    code: "GIT_CONTEXT_TASK_ROUTING_FAILED",
    message,
    category: "conflict",
    retryable: false,
    suggestedNextActions: ["Correct the task id or ask the user which task owns the requested resources."],
  });
}

function initialWorkState(): RunWorkStateInput {
  return {
    status: "not_done",
    summary: "Task run started.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
