import type { GitContextService, TaskDiscoveryView } from "ayati-git-context";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";

export function createTaskDiscoveryTools(service: GitContextService): ToolDefinition[] {
  return [
    findTasksTool(service),
    readTaskTool(service),
    inspectTaskLocationTool(service),
    setTaskStarTool(service),
  ];
}

function findTasksTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_find_tasks",
    description: "Find durable workstreams by intent, request, path, unfinished state, star, recency, or continuation frequency.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Task, request, or subject to find." },
        paths: {
          type: "array",
          maxItems: 20,
          items: { type: "string" },
          description: "Absolute resource paths whose owning task should be found.",
        },
        view: {
          enum: ["relevant", "unfinished", "starred", "recent", "frequent"],
          description: "Optional deterministic discovery view.",
        },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "object" } },
        count: { type: "integer" },
      },
      required: ["tasks", "count"],
      additionalProperties: false,
    },
    annotations: readAnnotations(),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "task", "workstream", "find", "recent", "starred"],
      aliases: ["find task", "search work", "recent work", "frequent work", "starred work"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const record = objectInput(input);
      const sessionId = context?.sessionId?.trim();
      if (!sessionId) return discoveryError("Task discovery requires the current session.");
      const query = optionalString(record, "query");
      const paths = stringArray(record["paths"]);
      const view = discoveryView(record["view"]);
      const includeArchived = record["includeArchived"] === true;
      const limit = integer(record["limit"]);
      if (record["view"] !== undefined && !view) {
        return discoveryError("Unknown task discovery view.");
      }
      if (record["limit"] !== undefined && (!limit || limit < 1 || limit > 50)) {
        return discoveryError("Task discovery limit must be between 1 and 50.");
      }
      try {
        const result = await service.findTasks({
          ...(query ? { query } : {}),
          ...(paths.length > 0 ? { paths } : {}),
          ...(view ? { view } : {}),
          ...(includeArchived ? { includeArchived: true } : {}),
          ...(limit ? { limit } : {}),
          sessionId,
        });
        return okJsonResult({
          code: "GIT_CONTEXT_TASKS_FOUND",
          message: result.tasks.length > 0
            ? `Found ${result.tasks.length} durable workstream candidate(s).`
            : "No matching durable workstream was found.",
          structuredContent: { tasks: result.tasks, count: result.tasks.length },
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function readTaskTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_read_task",
    description: "Open one candidate's committed task card, current request, recent commits, paths, and repository health without binding the run.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          pattern: "^T-[0-9]{8}-[0-9]{4}$",
          description: "Exact task identity returned by task discovery.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        task: { type: "object" },
        context: { type: "object" },
        opened: { const: true },
      },
      required: ["task", "context", "opened"],
      additionalProperties: false,
    },
    annotations: readAnnotations(),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "task", "workstream", "read", "inspect"],
      aliases: ["open task", "read task", "inspect workstream"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const taskId = optionalString(objectInput(input), "taskId");
      const identity = executionIdentity(context);
      if (!taskId || !/^T-\d{8}-\d{4}$/.test(taskId) || !identity) {
        return discoveryError("Opening a task requires a valid taskId and current run identity.");
      }
      try {
        const result = await service.readTask({
          requestId: identity.requestId + ":open-task",
          sessionId: identity.sessionId,
          runId: identity.runId,
          taskId,
          at: new Date().toISOString(),
        });
        return okJsonResult({
          code: "GIT_CONTEXT_TASK_OPENED",
          message: `Opened ${result.task.title} without binding the run.`,
          structuredContent: result,
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function setTaskStarTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_set_task_star",
    description: "Star or unstar one durable workstream only when the user explicitly requests that preference change.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", pattern: "^T-[0-9]{8}-[0-9]{4}$" },
        starred: { type: "boolean" },
        reason: { type: "string", description: "The user's explicit star or unstar instruction." },
      },
      required: ["taskId", "starred", "reason"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        starred: { type: "boolean" },
        starredAt: { type: "string" },
      },
      required: ["taskId", "starred"],
      additionalProperties: false,
    },
    annotations: commonAnnotations({
      domain: "git_context",
      readOnly: false,
      idempotent: true,
      retrySafe: true,
    }),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "task", "preference", "star"],
      aliases: ["star task", "unstar task", "favorite work"],
      domain: "git_context",
      priority: 8,
    },
    async execute(input, context): Promise<ToolResult> {
      const record = objectInput(input);
      const taskId = optionalString(record, "taskId");
      const reason = optionalString(record, "reason");
      const identity = executionIdentity(context);
      if (!taskId || !/^T-\d{8}-\d{4}$/.test(taskId)
        || typeof record["starred"] !== "boolean" || !reason || !identity) {
        return discoveryError("A valid taskId, starred value, explicit reason, and current run are required.");
      }
      try {
        const active = await service.getActiveContext({ sessionId: identity.sessionId });
        const run = active.run?.run;
        if (!run || run.runId !== identity.runId) {
          return discoveryError("Changing a task star requires the current active run.");
        }
        const userText = active.session?.pendingConversationContext
          .flatMap((conversation) => conversation.messages)
          .filter((message) => message.role === "user")
          .at(-1)?.content ?? "";
        if (!hasExplicitStarInstruction(userText, record["starred"])) {
          return discoveryError("Stars are user-controlled and require an explicit star or unstar instruction in the current turn.");
        }
        const result = await service.setTaskStar({
          requestId: identity.requestId + ":set-star",
          sessionId: identity.sessionId,
          runId: identity.runId,
          taskId,
          starred: record["starred"],
          at: run.startedAt,
        });
        return okJsonResult({
          code: result.starred ? "GIT_CONTEXT_TASK_STARRED" : "GIT_CONTEXT_TASK_UNSTARRED",
          message: result.starred ? "Workstream starred." : "Workstream unstarred.",
          structuredContent: result,
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function hasExplicitStarInstruction(text: string, starred: boolean): boolean {
  const normalized = text.toLowerCase();
  return starred
    ? /\b(?:star|favorite|favourite)\b/.test(normalized)
      && !/\b(?:unstar|unfavorite|unfavourite|remove (?:the )?star)\b/.test(normalized)
    : /\b(?:unstar|unfavorite|unfavourite|remove (?:the )?star)\b/.test(normalized);
}

function inspectTaskLocationTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_inspect_task_location",
    description: "Inspect a trusted existing directory before registering it as durable work; this never binds the run or changes user files.",
    inputSchema: {
      type: "object",
      properties: {
        workingDirectory: {
          type: "string",
          description: "Exact existing directory requested for durable work.",
        },
      },
      required: ["workingDirectory"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        canonicalPath: { type: "string" },
        kind: { enum: ["empty_directory", "clean_git_repository", "dirty_git_repository", "non_git_directory"] },
        trustedRoot: { type: "string" },
        branch: { type: "string" },
        head: { type: "string" },
        changes: { type: "array", items: { type: "string" } },
        entryCount: { type: "integer" },
        totalBytes: { type: "integer" },
        proposedPaths: { type: "array", items: { type: "string" } },
        excludedPaths: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
        registrationApprovalId: { type: "string" },
        approvalExpiresAt: { type: "string" },
      },
      required: [
        "canonicalPath",
        "kind",
        "trustedRoot",
        "entryCount",
        "totalBytes",
        "proposedPaths",
        "excludedPaths",
        "warnings",
      ],
      additionalProperties: false,
    },
    annotations: commonAnnotations({
      domain: "git_context",
      readOnly: false,
      idempotent: true,
      retrySafe: true,
    }),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "task", "workstream", "directory", "registration"],
      aliases: ["inspect task directory", "register existing directory", "open project folder"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const workingDirectory = optionalString(objectInput(input), "workingDirectory");
      const identity = executionIdentity(context);
      if (!workingDirectory || !identity) {
        return discoveryError("Task location inspection requires an existing directory and current run identity.");
      }
      try {
        const active = await service.getActiveContext({ sessionId: identity.sessionId });
        const conversation = active.session?.pendingConversationContext.at(-1)?.conversation;
        const run = active.run?.run;
        if (!conversation || !run || run.runId !== identity.runId
          || run.conversationId !== conversation.conversationId) {
          return discoveryError("Task location inspection requires the current active conversation.");
        }
        const result = await service.inspectTaskLocation({
          requestId: identity.requestId + ":inspect-location",
          sessionId: identity.sessionId,
          conversationId: conversation.conversationId,
          runId: identity.runId,
          workingDirectory,
          at: run.startedAt,
        });
        return okJsonResult({
          code: "GIT_CONTEXT_TASK_LOCATION_INSPECTED",
          message: result.kind === "non_git_directory"
            ? "Directory inventory is ready for explicit user approval before registration."
            : `Directory is classified as ${result.kind}.`,
          structuredContent: result,
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function readAnnotations() {
  return commonAnnotations({
    domain: "git_context",
    readOnly: true,
    idempotent: true,
    retrySafe: true,
  });
}

function executionIdentity(context?: ToolExecutionContext): {
  sessionId: string;
  runId: string;
  requestId: string;
} | undefined {
  const sessionId = context?.sessionId?.trim();
  const runId = context?.runId?.trim();
  const callId = context?.callId?.trim();
  if (!sessionId || !runId || !callId) return undefined;
  return { sessionId, runId, requestId: runId + ":" + callId };
}

function discoveryView(value: unknown): TaskDiscoveryView | undefined {
  return value === "relevant"
      || value === "unfinished"
      || value === "starred"
      || value === "recent"
      || value === "frequent"
    ? value
    : undefined;
}

function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function discoveryError(message: string): ToolResult {
  return errorResult({
    code: "GIT_CONTEXT_TASK_DISCOVERY_FAILED",
    message,
    category: "conflict",
    retryable: false,
    suggestedNextActions: ["Refine the task search or ask one focused ownership question."],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
