import type {
  GitContextService,
  SelectedTaskForRunResponse,
} from "ayati-git-context";
import { buildContextEngineProjection } from "../../../context-engine/index.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";
import type { TaskRequestRoute } from "ayati-git-context";
import { createTaskDiscoveryTools } from "./discovery-tools.js";

export interface GitContextSkillDeps {
  service: GitContextService;
}

const PROMPT = [
  "Tasks are long-lived workstreams stored in independent Git repositories with one stable working directory.",
  "A request is one bounded feature, lesson, analysis, or improvement inside a task; a run is only the current attempt.",
  "Continue the current request only when the user is still pursuing its unfinished outcome. A materially separate outcome belongs to a new request in the same task, not automatically to a new task.",
  "Completing one request does not complete or archive its task. A task may remain active with no current request.",
  "There is no session-global active task. Each task-bound run owns exactly one task.",
  "The current context contains a compact mix of exact, relevant, unfinished, starred, recent, and frequent workstreams.",
  "Use git_context_find_tasks when the compact candidates are insufficient, and git_context_read_task to confirm ownership without binding the run.",
  "Exact task identity, canonical path ownership, and explicit conversational continuation are stronger than text relevance. Star, recency, and frequency help discovery but never prove ownership.",
  "Use git_context_activate_task when the request continues or changes an existing task.",
  "Use git_context_create_task only when the request starts a distinct durable deliverable.",
  "Never default an unclear mutation to the most recent task. Ask the user when ownership remains ambiguous.",
  "Create durable work automatically when the user begins a stable goal likely to recur across sessions, a multi-step deliverable, ongoing learning or research, maintained automation, or work that creates or mutates persistent artifacts. Casual conversation, one-off explanations, and isolated list/search/read observations remain unbound unless the user establishes an ongoing goal.",
  "A task is the durable subject or owned resource. A request is the bounded outcome being pursued now. Reuse the same task for later lessons, features, investigations, maintenance, and improvements that share that durable subject or resource.",
  "Stars are strictly user-controlled. Never star or unstar a workstream unless the current user message explicitly asks for it.",
  "New tasks normally use a managed repository. A user-requested existing directory must first pass Git Context location inspection and registration policy.",
  "Use git_context_inspect_task_location for that inspection. Empty directories and clean Git roots can be registered directly. Dirty Git roots require the user to reconcile changes. Non-empty non-Git directories require showing the proposed and excluded paths, ending the run for explicit approval, then using the returned receipt in the next run.",
  "When activating a T-* task, explicitly choose requestDecision=continue for its unfinished current request or requestDecision=create for a materially separate outcome in the same task.",
  "Do not create a new task merely because the current request is complete; create a new request in the existing task when the durable workstream is the same.",
  "For external actions, keep only verified non-secret identifiers or safe receipt paths in durable task context; Git does not own or undo external state.",
  "After either tool succeeds, use absolute paths rooted inside the returned workingDirectory for every host filesystem tool call.",
].join("\n");

export function createGitContextSkill(deps: GitContextSkillDeps): SkillDefinition {
  return {
    id: "git-context",
    version: "3.0.0",
    description: "Discover, open, create, and continue durable Git workstreams without user-managed sessions.",
    promptBlock: PROMPT,
    tools: [
      createTaskTool(deps),
      activateTaskTool(deps.service),
      ...createTaskDiscoveryTools(deps.service),
    ],
  };
}

function createTaskTool(deps: GitContextSkillDeps): ToolDefinition {
  const service = deps.service;
  return {
    name: "git_context_create_task",
    description: "Create one durable task repository, optionally registering an inspected trusted directory, and start its initial request.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short durable task title." },
        objective: { type: "string", description: "Concrete deliverable or durable objective." },
        reason: { type: "string", description: "Why this request is a new task instead of an existing task." },
        workingDirectory: {
          type: "string",
          description: "Optional trusted existing directory previously inspected by Git Context.",
        },
        registrationApprovalId: {
          type: "string",
          description: "Approval receipt required for a non-empty non-Git directory baseline.",
        },
      },
      required: ["title", "objective", "reason"],
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
        const run = active.run?.run;
        if (!run || run.conversationId !== conversation.conversationId) {
          return routingError("Task creation requires the current prepared run.");
        }
        const operationAt = run.startedAt;
        const selected = await service.createTaskForRun({
          requestId: toolRequestId(context, "create-task"),
          sessionId: parsed.sessionId,
          conversationId: conversation.conversationId,
          runId: run.runId,
          title: parsed.title,
          objective: parsed.objective,
          placement: parsed.workingDirectory
            ? {
                mode: "requested",
                workingDirectory: parsed.workingDirectory,
                ...(parsed.registrationApprovalId
                  ? { registrationApprovalId: parsed.registrationApprovalId }
                  : {}),
              }
            : { mode: "managed" },
          at: operationAt,
        });
        await service.bindTaskAttachments({
          requestId: toolRequestId(context, "bind-attachments"),
          sessionId: parsed.sessionId,
          conversationId: conversation.conversationId,
          runId: selected.run.runId,
          taskId: selected.task.taskId,
          at: operationAt,
        });
        return routingSuccess(service, parsed.sessionId, selected, "created");
      } catch (error) {
        return routingError(errorMessage(error));
      }
    },
  };
}

function activateTaskTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_activate_task",
    description: "Select an existing V1 task repository and explicitly continue its unfinished request or create a new active request.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", pattern: "^T-[0-9]{8}-[0-9]{4}$", description: "Exact V1 task id from current task candidates." },
        reason: { type: "string", description: "Why the current request belongs to this task and its resources." },
        requestDecision: {
          type: "object",
          description: "Continue the exact unfinished request, or create one materially separate request in the same V1 task.",
          properties: {
            kind: { enum: ["continue", "create"] },
            requestId: { type: "string", pattern: "^R-[0-9]{4}$" },
            title: { type: "string" },
            request: { type: "string" },
            acceptance: { type: "array", items: { type: "string" } },
            constraints: { type: "array", items: { type: "string" } },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      required: ["taskId", "reason", "requestDecision"],
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
        const run = active.run?.run;
        if (!run || run.conversationId !== conversation.conversationId) {
          return routingError("Task activation requires the current prepared run.");
        }
        const operationAt = run.startedAt;
        const selected = await service.activateTaskForRun({
          requestId: toolRequestId(context, "activate-task"),
          sessionId: parsed.sessionId,
          conversationId: conversation.conversationId,
          runId: run.runId,
          taskId: parsed.taskId,
          route: parsed.route,
          at: operationAt,
        });
        await service.bindTaskAttachments({
          requestId: toolRequestId(context, "bind-attachments"),
          sessionId: parsed.sessionId,
          conversationId: conversation.conversationId,
          runId: selected.run.runId,
          taskId: selected.task.taskId,
          at: operationAt,
        });
        return routingSuccess(service, parsed.sessionId, selected, "activated");
      } catch (error) {
        return routingError(errorMessage(error));
      }
    },
  };
}

async function routingSuccess(
  service: GitContextService,
  sessionId: string,
  selected: SelectedTaskForRunResponse,
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
      taskId: selected.task.taskId,
      branch: task.task.branch,
      mode,
      runId: selected.run.runId,
      workingDirectory: task.workingDirectory,
      taskHead: selected.task.head,
      taskCreated: selected.taskCreated,
      requestDecision: selected.taskRequestDecision,
      taskRequestId: selected.run.taskBinding?.taskRequestId,
      taskRequestStatus: selected.context.currentRequest?.status,
      taskRequestCreated: selected.taskRequestCreated,
      headBeforeSelection: selected.headBeforeSelection,
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
      taskHead: { type: "string" },
      taskCreated: { type: "boolean" },
      requestDecision: { enum: ["initial", "continue", "create"] },
      taskRequestId: { type: "string" },
      taskRequestStatus: { enum: ["queued", "active", "blocked", "done", "dropped"] },
      taskRequestCreated: { type: "boolean" },
      headBeforeSelection: { type: "string" },
      harnessContext: { type: "object" },
    },
    required: [
      "status",
      "sessionId",
      "taskId",
      "branch",
      "mode",
      "runId",
      "workingDirectory",
      "taskHead",
      "taskCreated",
      "requestDecision",
      "taskRequestCreated",
      "headBeforeSelection",
      "harnessContext",
    ],
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

function parseCreateInput(input: unknown, context?: ToolExecutionContext): {
  sessionId: string;
  title: string;
  objective: string;
  reason: string;
  workingDirectory?: string;
  registrationApprovalId?: string;
} | ToolResult {
  const record = objectInput(input);
  const sessionId = context?.sessionId?.trim();
  const title = stringField(record, "title");
  const objective = stringField(record, "objective");
  const reason = stringField(record, "reason");
  if (!sessionId || !title || !objective || !reason) {
    return routingError("sessionId, title, objective, and reason are required.");
  }
  const workingDirectory = stringField(record, "workingDirectory");
  const registrationApprovalId = stringField(record, "registrationApprovalId");
  if (registrationApprovalId && !workingDirectory) {
    return routingError("registrationApprovalId requires workingDirectory.");
  }
  return {
    sessionId,
    title,
    objective,
    reason,
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(registrationApprovalId ? { registrationApprovalId } : {}),
  };
}

function parseActivateInput(input: unknown, context?: ToolExecutionContext): {
  sessionId: string;
  taskId: string;
  reason: string;
  route: TaskRequestRoute;
} | ToolResult {
  const record = objectInput(input);
  const sessionId = context?.sessionId?.trim();
  const taskId = stringField(record, "taskId");
  const reason = stringField(record, "reason");
  if (!sessionId || !taskId || !/^T-\d{8}-\d{4}$/.test(taskId) || !reason) {
    return routingError("sessionId, a valid V1 T-* taskId, and reason are required.");
  }
  const route = parseRequestDecision(record["requestDecision"], reason);
  if (!route) {
    return routingError("T-* task activation requires requestDecision=continue or requestDecision=create with complete request details.");
  }
  return { sessionId, taskId, reason, route };
}

function parseRequestDecision(value: unknown, reason: string): TaskRequestRoute | undefined {
  const record = objectInput(value);
  if (record["kind"] === "continue") {
    const requestId = stringField(record, "requestId");
    return requestId && /^R-\d{4}$/.test(requestId)
      ? { kind: "continue_active_request", requestId, reason }
      : undefined;
  }
  if (record["kind"] === "create") {
    const title = stringField(record, "title");
    const request = stringField(record, "request");
    const acceptance = stringArray(record["acceptance"]);
    const constraints = stringArray(record["constraints"]);
    return title && request && acceptance.length > 0
      ? { kind: "create_active_request", title, request, acceptance, constraints, reason }
      : undefined;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolRequestId(context: ToolExecutionContext | undefined, operation: string): string {
  const runId = context?.runId?.trim();
  const callId = context?.callId?.trim();
  if (!runId || !callId) {
    throw new Error("Git Context routing requires run and tool-call identity.");
  }
  return runId + ":" + callId + ":" + operation;
}
