import {
  buildGitMemoryContextPackFromMemoryState,
  buildGitMemoryHarnessContextFromMemoryState,
  GitContextMemoryStateHydrator,
  GitMemoryDailySessionStore,
  type GitContextMemoryState,
  type GitMemoryRuntime,
  type GitMemoryContextLimits,
  type ReadGitMemoryEvidenceInput,
  type SearchGitMemoryEvidenceInput,
  type GitMemoryTaskDetailInclude,
  type GitMemoryTaskDetailLimits,
  type GitMemoryTaskStatus,
} from "../../../context-engine/git-memory/index.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import { commonAnnotations, errorResult, genericObjectOutputSchema, okJsonResult, succeededContract } from "../contract-helpers.js";

export interface GitContextSkillDeps {
  contextStoreDir: string;
  gitMemoryRuntime?: GitMemoryRuntime;
}

interface SessionScopedInput {
  sessionId?: string;
}

interface ListSessionsInput {
  limit?: number;
}

interface ActiveContextInput {
  sessionId: string;
  limits?: Partial<GitMemoryContextLimits>;
}

interface TaskSelectorInput {
  sessionId: string;
  taskId?: string;
  branch?: string;
}

interface ReadTaskInput extends TaskSelectorInput {
  include?: GitMemoryTaskDetailInclude[];
  limits?: Partial<GitMemoryTaskDetailLimits>;
}

interface ReadLogInput extends TaskSelectorInput {
  target: "main" | "task";
  limit?: number;
}

interface SearchTasksInput {
  sessionId: string;
  query: string;
  limit?: number;
  status?: GitMemoryTaskStatus;
}

interface ReadEvidenceInput extends TaskSelectorInput {
  runId?: string;
  limit?: number;
}

interface SearchEvidenceInput extends SessionScopedInput {
  sessionId: string;
  query: string;
  taskId?: string;
  branch?: string;
  limit?: number;
}

interface SwitchTaskInput extends TaskSelectorInput {
  reason: string;
}

interface CreateTaskInput extends SessionScopedInput {
  sessionId: string;
  title: string;
  objective: string;
  reason: string;
}

interface AskClarificationForTurnInput extends SessionScopedInput {
  sessionId: string;
  reason: string;
  candidateTaskIds?: string[];
}

const TASK_DETAIL_INCLUDES: GitMemoryTaskDetailInclude[] = [
  "task",
  "state",
  "runs",
  "markdown",
  "actions",
  "assets",
  "commits",
  "evidence",
  "conversation",
];

const TASK_STATUSES: GitMemoryTaskStatus[] = ["open", "in_progress", "blocked", "done", "abandoned"];

const GIT_CONTEXT_PROMPT_BLOCK = [
  "Most git-context tools are read-only. Turn-aware git-context tools mutate only git-context task branch routing state through the runtime.",
  "Use git-context tools to inspect Ayati's daily git context sessions, active context, and task routing snapshots.",
  "Prefer git_context_list_sessions to discover available daily sessions.",
  "Use git_context_active to inspect the current compact git context for a session.",
  "Use git_context_list_tasks to compare known task branches before deciding whether prior task context matters.",
  "Use git_context_search_tasks to find likely matching prior tasks by title, summary, facts, open work, blockers, next step, branch, or status.",
  "Use git_context_read_task to inspect one task branch deeply with bounded runs, actions, assets, commits, evidence, and Markdown conversation.",
  "Use git_context_read_evidence to read compact durable evidence records for a task or run.",
  "Use git_context_search_evidence to find compact durable evidence records by summary, tool, fact, artifact, run id, action id, or evidence ref.",
  "Use git_context_log to inspect compact commit history for main or one task branch.",
  "Use git_context_activate_task_for_turn when the current pending user turn belongs to a different existing task.",
  "Use git_context_create_task_for_turn when the current pending user turn starts new durable task work.",
  "Use git_context_ask_clarification_for_turn when the current pending user turn has ambiguous task ownership.",
  "Do not call a tool just to continue the already-active task; obvious same-task continuation is automatic.",
  "Do not switch or create task branches with low-level branch tools during normal live turns; route pending turns through the turn-aware tools.",
  "Do not use git-context tools to edit project files, merge, reset, push, pull, or mutate external state.",
].join("\n");

export function createGitContextSkill(deps: GitContextSkillDeps): SkillDefinition {
  const store = new GitMemoryDailySessionStore({ contextStoreDir: deps.contextStoreDir });
  const memoryStateHydrator = new GitContextMemoryStateHydrator(store);
  const runtime = deps.gitMemoryRuntime;

  return {
    id: "git-context",
    version: "1.0.0",
    description: "Inspection and controlled task-branch routing for Ayati daily git context sessions.",
    promptBlock: GIT_CONTEXT_PROMPT_BLOCK,
    tools: [
      createListSessionsTool(store),
      createActiveContextTool(memoryStateHydrator, runtime),
      createListTasksTool(store),
      createSearchTasksTool(store),
      createReadTaskTool(store),
      createReadEvidenceTool(store),
      createSearchEvidenceTool(store),
      createLogTool(store),
      createActivateTaskForTurnTool(store, runtime),
      createCreateTaskForTurnTool(runtime),
      createAskClarificationForTurnTool(runtime),
    ],
  };
}

function createListSessionsTool(store: GitMemoryDailySessionStore): ToolDefinition {
  return {
    name: "git_context_list_sessions",
    description: "List known Ayati daily git-context sessions without mutating repos, refs, or files.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum sessions to return. Defaults to 50, max 100.",
        },
      },
    },
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextReadOnlyAnnotations(),
    resultContract: gitContextSucceededContract("sessions_listed"),
    selectionHints: {
      tags: ["git-context", "sessions", "tasks", "read-only"],
      aliases: ["list git context sessions", "daily context sessions"],
      domain: "git_context",
    },
    async execute(input): Promise<ToolResult> {
      const parsed = parseListSessionsInput(input);
      if ("ok" in parsed) {
        return parsed;
      }
      const sessions = await store.listSessions({ limit: parsed.limit });
      return okJsonResult({
        code: "GIT_CONTEXT_SESSIONS_LISTED",
        message: "Git-context sessions listed.",
        structuredContent: { sessions },
      });
    },
  };
}

function createActiveContextTool(
  memoryStateHydrator: GitContextMemoryStateHydrator,
  runtime: GitMemoryRuntime | undefined,
): ToolDefinition {
  return {
    name: "git_context_active",
    description: "Read the compact active git context for an Ayati daily session.",
    inputSchema: sessionScopedInputSchema({
      limits: {
        type: "object",
        description: "Optional context reader limits.",
        properties: {
          conversationTailLimit: { type: "number" },
          activityTailLimit: { type: "number" },
          runLimit: { type: "number" },
          evidenceLimit: { type: "number" },
          commitLogLimit: { type: "number" },
          conversationMarkdownCharLimit: { type: "number" },
        },
      },
    }),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextReadOnlyAnnotations(),
    resultContract: gitContextSucceededContract("active_context_read"),
    selectionHints: {
      tags: ["git-context", "active", "focus", "task", "read-only"],
      aliases: ["read active git context", "current git context"],
      domain: "git_context",
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseActiveContextInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      const memoryState = runtime && !parsed.limits
        ? await runtime.buildMemoryState(parsed.sessionId)
        : await memoryStateHydrator.hydrate({
          sessionId: parsed.sessionId,
          limits: parsed.limits,
        });
      const activeContext = buildGitMemoryContextPackFromMemoryState(memoryState);
      return okJsonResult({
        code: "GIT_CONTEXT_ACTIVE_READ",
        message: "Active git context read.",
        structuredContent: activeContext,
      });
    },
  };
}

function createListTasksTool(store: GitMemoryDailySessionStore): ToolDefinition {
  return {
    name: "git_context_list_tasks",
    description: "List known task branches and task routing snapshot data for a git-context session.",
    inputSchema: sessionScopedInputSchema(),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextReadOnlyAnnotations(),
    resultContract: gitContextSucceededContract("tasks_listed"),
    selectionHints: {
      tags: ["git-context", "tasks", "branches", "routing", "read-only"],
      aliases: ["list git context tasks", "task branches", "work branches"],
      domain: "git_context",
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseSessionScopedInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      const snapshot = await store.readTaskRoutingSnapshot(parsed.sessionId);
      return okJsonResult({
        code: "GIT_CONTEXT_TASKS_LISTED",
        message: "Git-context tasks listed.",
        structuredContent: snapshot,
      });
    },
  };
}

function createSearchTasksTool(store: GitMemoryDailySessionStore): ToolDefinition {
  return {
    name: "git_context_search_tasks",
    description: "Search known git-context task branches by title, summary, facts, next step, branch, and status.",
    inputSchema: sessionScopedInputSchema({
      query: {
        type: "string",
        description: "Search text for a prior task, such as upload validation bug.",
      },
      limit: {
        type: "number",
        description: "Maximum matches to return. Defaults to 5, max 100.",
      },
      status: {
        type: "string",
        enum: TASK_STATUSES,
        description: "Optional task status filter.",
      },
    }),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextReadOnlyAnnotations(),
    resultContract: gitContextSucceededContract("tasks_searched"),
    selectionHints: {
      tags: ["git-context", "tasks", "search", "routing", "prior-task", "read-only"],
      aliases: ["search git context tasks", "find task branch", "find prior work"],
      domain: "git_context",
      priority: 4,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseSearchTasksInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      try {
        const result = await store.searchTasks(parsed);
        return okJsonResult({
          code: "GIT_CONTEXT_TASKS_SEARCHED",
          message: "Git-context tasks searched.",
          structuredContent: result,
        });
      } catch (err) {
        return gitContextReadFailed(err);
      }
    },
  };
}

function createReadTaskTool(store: GitMemoryDailySessionStore): ToolDefinition {
  return {
    name: "git_context_read_task",
    description: "Read one git-context task branch deeply by task id or branch, with bounded sections.",
    inputSchema: sessionScopedInputSchema({
      taskId: {
        type: "string",
        description: "Task id to read. Provide exactly one of taskId or branch.",
      },
      branch: {
        type: "string",
        description: "Task branch to read. Provide exactly one of taskId or branch.",
      },
      include: {
        type: "array",
        description: "Optional sections to include. Defaults to all sections.",
        items: {
          type: "string",
          enum: TASK_DETAIL_INCLUDES,
        },
      },
      limits: {
        type: "object",
        description: "Optional bounded read limits.",
        properties: {
          runLimit: { type: "number" },
          actionRunLimit: { type: "number" },
          actionLimit: { type: "number" },
          commitLogLimit: { type: "number" },
          evidenceLimit: { type: "number" },
          conversationMarkdownCharLimit: { type: "number" },
          taskMarkdownCharLimit: { type: "number" },
          runMarkdownCharLimit: { type: "number" },
        },
      },
    }),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextReadOnlyAnnotations(),
    resultContract: gitContextSucceededContract("task_read"),
    selectionHints: {
      tags: ["git-context", "task", "branch", "runs", "actions", "assets", "commits", "evidence", "conversation", "read-only"],
      aliases: ["read git context task", "inspect task branch", "read work branch"],
      domain: "git_context",
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseReadTaskInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      try {
        const detail = await store.readTaskDetail(parsed);
        return okJsonResult({
          code: "GIT_CONTEXT_TASK_READ",
          message: "Git-context task read.",
          structuredContent: detail,
        });
      } catch (err) {
        return gitContextReadFailed(err);
      }
    },
  };
}

function createReadEvidenceTool(store: GitMemoryDailySessionStore): ToolDefinition {
  return {
    name: "git_context_read_evidence",
    description: "Read compact durable evidence manifest records for one git-context task or run.",
    inputSchema: sessionScopedInputSchema({
      taskId: {
        type: "string",
        description: "Task id to read. Provide exactly one of taskId or branch.",
      },
      branch: {
        type: "string",
        description: "Task branch to read. Provide exactly one of taskId or branch.",
      },
      runId: {
        type: "string",
        description: "Optional run id. When provided, reads that run's evidence manifest.",
      },
      limit: {
        type: "number",
        description: "Maximum evidence records to return. Defaults to 20, max 100.",
      },
    }),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextReadOnlyAnnotations(),
    resultContract: gitContextSucceededContract("evidence_read"),
    selectionHints: {
      tags: ["git-context", "evidence", "task", "run", "read-only"],
      aliases: ["read git context evidence", "read task evidence", "read run evidence"],
      domain: "git_context",
      priority: 4,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseReadEvidenceInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      try {
        const evidence = await store.readEvidence(parsed);
        return okJsonResult({
          code: "GIT_CONTEXT_EVIDENCE_READ",
          message: "Git-context evidence read.",
          structuredContent: evidence,
        });
      } catch (err) {
        return gitContextReadFailed(err);
      }
    },
  };
}

function createSearchEvidenceTool(store: GitMemoryDailySessionStore): ToolDefinition {
  return {
    name: "git_context_search_evidence",
    description: "Search compact durable evidence manifest records in a git-context session or task.",
    inputSchema: sessionScopedInputSchema({
      query: {
        type: "string",
        description: "Search text, such as upload validation, pnpm test, an artifact path, run id, or action id.",
      },
      taskId: {
        type: "string",
        description: "Optional task id to scope evidence search. Provide at most one of taskId or branch.",
      },
      branch: {
        type: "string",
        description: "Optional task branch to scope evidence search. Provide at most one of taskId or branch.",
      },
      limit: {
        type: "number",
        description: "Maximum evidence matches to return. Defaults to 10, max 100.",
      },
    }),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextReadOnlyAnnotations(),
    resultContract: gitContextSucceededContract("evidence_searched"),
    selectionHints: {
      tags: ["git-context", "evidence", "search", "task", "run", "read-only"],
      aliases: ["search git context evidence", "find task evidence", "find run evidence"],
      domain: "git_context",
      priority: 5,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseSearchEvidenceInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      try {
        const result = await store.searchEvidence(parsed);
        return okJsonResult({
          code: "GIT_CONTEXT_EVIDENCE_SEARCHED",
          message: "Git-context evidence searched.",
          structuredContent: result,
        });
      } catch (err) {
        return gitContextReadFailed(err);
      }
    },
  };
}

function createLogTool(store: GitMemoryDailySessionStore): ToolDefinition {
  return {
    name: "git_context_log",
    description: "Read compact git-context commit history for main or one task branch.",
    inputSchema: sessionScopedInputSchema({
      target: {
        type: "string",
        enum: ["main", "task"],
        description: "Commit history target. Defaults to main.",
      },
      taskId: {
        type: "string",
        description: "Task id when target=task. Provide exactly one of taskId or branch.",
      },
      branch: {
        type: "string",
        description: "Task branch when target=task. Provide exactly one of taskId or branch.",
      },
      limit: {
        type: "number",
        description: "Maximum commits to return. Defaults to 20, max 100.",
      },
    }),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextReadOnlyAnnotations(),
    resultContract: gitContextSucceededContract("log_read"),
    selectionHints: {
      tags: ["git-context", "log", "commits", "history", "trailers", "read-only"],
      aliases: ["read git context log", "task commit history", "main context log"],
      domain: "git_context",
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseReadLogInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      try {
        const log = await store.readSessionLog(parsed);
        return okJsonResult({
          code: "GIT_CONTEXT_LOG_READ",
          message: "Git-context log read.",
          structuredContent: log,
        });
      } catch (err) {
        return gitContextReadFailed(err);
      }
    },
  };
}

function createActivateTaskForTurnTool(
  store: GitMemoryDailySessionStore,
  runtime: GitMemoryRuntime | undefined,
): ToolDefinition {
  return {
    name: "git_context_activate_task_for_turn",
    description: "Bind the current pending user turn to an existing git-context task branch, start a run, and refresh active context.",
    inputSchema: sessionScopedInputSchema({
      taskId: {
        type: "string",
        description: "Task id to activate for the pending turn. Provide exactly one of taskId or branch.",
      },
      branch: {
        type: "string",
        description: "Task branch to activate for the pending turn. Provide exactly one of taskId or branch.",
      },
      reason: {
        type: "string",
        description: "Short reason this pending turn belongs to the selected task.",
      },
    }),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextTurnMutationAnnotations(),
    resultContract: gitContextSucceededContract("turn_task_activated"),
    selectionHints: {
      tags: ["git-context", "pending-turn", "task", "activate", "routing", "mutating"],
      aliases: ["activate task for turn", "route pending turn to existing task", "switch pending turn task"],
      domain: "git_context",
      priority: 7,
    },
    async execute(input, context): Promise<ToolResult> {
      if (!runtime) {
        return gitContextMutationFailed(new Error("git_context_activate_task_for_turn requires a live git memory runtime."));
      }
      const parsed = parseSwitchTaskInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      try {
        const taskId = await resolveTaskIdFromSelector(store, parsed);
        const route = await runtime.activateTaskForTurn({
          sessionId: parsed.sessionId,
          taskId,
          reason: parsed.reason,
        });
        return okJsonResult({
          code: "GIT_CONTEXT_TURN_TASK_ACTIVATED",
          message: "Pending turn activated on existing git-context task.",
          structuredContent: withHarnessContext(route),
        });
      } catch (err) {
        return gitContextMutationFailed(err);
      }
    },
  };
}

function createCreateTaskForTurnTool(runtime: GitMemoryRuntime | undefined): ToolDefinition {
  return {
    name: "git_context_create_task_for_turn",
    description: "Create a new git-context task for the current pending user turn, start a run, and refresh active context.",
    inputSchema: sessionScopedInputSchema({
      title: {
        type: "string",
        description: "Short task title.",
      },
      objective: {
        type: "string",
        description: "Durable task objective.",
      },
      reason: {
        type: "string",
        description: "Short reason this pending turn should create a new task.",
      },
    }),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextTurnMutationAnnotations(),
    resultContract: gitContextSucceededContract("turn_task_created"),
    selectionHints: {
      tags: ["git-context", "pending-turn", "task", "create", "routing", "mutating"],
      aliases: ["create task for turn", "route pending turn to new task", "start new pending turn task"],
      domain: "git_context",
      priority: 7,
    },
    async execute(input, context): Promise<ToolResult> {
      if (!runtime) {
        return gitContextMutationFailed(new Error("git_context_create_task_for_turn requires a live git memory runtime."));
      }
      const parsed = parseCreateTaskInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      try {
        const route = await runtime.createTaskForTurn({
          sessionId: parsed.sessionId,
          title: parsed.title,
          objective: parsed.objective,
          reason: parsed.reason,
        });
        return okJsonResult({
          code: "GIT_CONTEXT_TURN_TASK_CREATED",
          message: "Pending turn created a new git-context task.",
          structuredContent: withHarnessContext(route),
        });
      } catch (err) {
        return gitContextMutationFailed(err);
      }
    },
  };
}

function createAskClarificationForTurnTool(runtime: GitMemoryRuntime | undefined): ToolDefinition {
  return {
    name: "git_context_ask_clarification_for_turn",
    description: "Mark the current pending user turn as needing task-ownership clarification without starting a run.",
    inputSchema: sessionScopedInputSchema({
      reason: {
        type: "string",
        description: "Short reason task ownership is ambiguous.",
      },
      candidateTaskIds: {
        type: "array",
        description: "Optional candidate task ids that may own the pending turn.",
        items: {
          type: "string",
        },
      },
    }),
    outputSchema: genericObjectOutputSchema,
    annotations: gitContextTurnMutationAnnotations(),
    resultContract: gitContextSucceededContract("turn_clarification_requested"),
    selectionHints: {
      tags: ["git-context", "pending-turn", "clarify", "ambiguous", "routing", "mutating"],
      aliases: ["ask clarification for turn", "mark pending turn ambiguous", "clarify task ownership"],
      domain: "git_context",
      priority: 7,
    },
    async execute(input, context): Promise<ToolResult> {
      if (!runtime) {
        return gitContextMutationFailed(new Error("git_context_ask_clarification_for_turn requires a live git memory runtime."));
      }
      const parsed = parseAskClarificationForTurnInput(input, context);
      if ("ok" in parsed) {
        return parsed;
      }
      try {
        const route = await runtime.askClarificationForTurn({
          sessionId: parsed.sessionId,
          reason: parsed.reason,
          ...(parsed.candidateTaskIds ? { candidateTaskIds: parsed.candidateTaskIds } : {}),
        });
        return okJsonResult({
          code: "GIT_CONTEXT_TURN_CLARIFICATION_REQUESTED",
          message: "Pending turn marked as needing task clarification.",
          structuredContent: withHarnessContext(route),
        });
      } catch (err) {
        return gitContextMutationFailed(err);
      }
    },
  };
}

function parseListSessionsInput(input: unknown): ListSessionsInput | ToolResult {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return invalidInput("expected an object.");
  }
  const value = input as Partial<ListSessionsInput>;
  if (value.limit !== undefined && !isValidLimit(value.limit)) {
    return invalidInput("limit must be a positive integer.");
  }
  return {
    ...(typeof value.limit === "number" ? { limit: Math.floor(value.limit) } : {}),
  };
}

function parseActiveContextInput(input: unknown, context?: ToolExecutionContext): ActiveContextInput | ToolResult {
  const scoped = parseSessionScopedInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<ActiveContextInput>
    : {};
  if (value.limits !== undefined) {
    if (!value.limits || typeof value.limits !== "object" || Array.isArray(value.limits)) {
      return invalidInput("limits must be an object when provided.");
    }
    const limits = value.limits as Record<string, unknown>;
    for (const [key, limit] of Object.entries(limits)) {
      if (limit !== undefined && !isValidLimit(limit)) {
        return invalidInput(`limits.${key} must be a positive integer.`);
      }
    }
  }
  return {
    sessionId: scoped.sessionId,
    ...(value.limits ? { limits: value.limits } : {}),
  };
}

function parseSearchTasksInput(input: unknown, context?: ToolExecutionContext): SearchTasksInput | ToolResult {
  const scoped = parseSessionScopedInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<SearchTasksInput>
    : {};
  if (typeof value.query !== "string" || value.query.trim().length === 0) {
    return invalidInput("query must be a non-empty string.");
  }
  if (value.limit !== undefined && !isValidLimit(value.limit)) {
    return invalidInput("limit must be a positive integer.");
  }
  if (value.status !== undefined && !TASK_STATUSES.includes(value.status)) {
    return invalidInput("status must be one of open, in_progress, blocked, done, or abandoned.");
  }
  return {
    sessionId: scoped.sessionId,
    query: value.query.trim(),
    ...(typeof value.limit === "number" ? { limit: Math.floor(value.limit) } : {}),
    ...(value.status ? { status: value.status } : {}),
  };
}

function parseCreateTaskInput(input: unknown, context?: ToolExecutionContext): CreateTaskInput | ToolResult {
  const scoped = parseSessionScopedInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<CreateTaskInput>
    : {};
  const title = trimRequired(value.title, "title");
  if (typeof title !== "string") {
    return title;
  }
  const objective = trimRequired(value.objective, "objective");
  if (typeof objective !== "string") {
    return objective;
  }
  const reason = trimRequired(value.reason, "reason");
  if (typeof reason !== "string") {
    return reason;
  }
  return {
    sessionId: scoped.sessionId,
    title,
    objective,
    reason,
  };
}

function parseAskClarificationForTurnInput(
  input: unknown,
  context?: ToolExecutionContext,
): AskClarificationForTurnInput | ToolResult {
  const scoped = parseSessionScopedInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<AskClarificationForTurnInput>
    : {};
  const reason = trimRequired(value.reason, "reason");
  if (typeof reason !== "string") {
    return reason;
  }
  if (value.candidateTaskIds !== undefined && !Array.isArray(value.candidateTaskIds)) {
    return invalidInput("candidateTaskIds must be an array when provided.");
  }
  const candidateTaskIds: string[] = [];
  for (const taskId of value.candidateTaskIds ?? []) {
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      return invalidInput("candidateTaskIds must contain only non-empty strings.");
    }
    const trimmed = taskId.trim();
    if (!candidateTaskIds.includes(trimmed)) {
      candidateTaskIds.push(trimmed);
    }
  }
  return {
    sessionId: scoped.sessionId,
    reason,
    ...(candidateTaskIds.length > 0 ? { candidateTaskIds } : {}),
  };
}

async function resolveTaskIdFromSelector(
  store: GitMemoryDailySessionStore,
  input: TaskSelectorInput,
): Promise<string> {
  if (input.taskId) {
    return input.taskId;
  }
  const snapshot = await store.readTaskRoutingSnapshot(input.sessionId);
  const match = snapshot.tasks.find((task) => task.branch === input.branch);
  if (!match) {
    throw new Error(`Git memory task branch not found: ${input.branch}`);
  }
  return match.taskId;
}

function parseSwitchTaskInput(input: unknown, context?: ToolExecutionContext): SwitchTaskInput | ToolResult {
  const scoped = parseTaskSelectorInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<SwitchTaskInput>
    : {};
  if (typeof value.reason !== "string" || value.reason.trim().length === 0) {
    return invalidInput("reason must be a non-empty string.");
  }
  return {
    ...scoped,
    reason: value.reason.trim(),
  };
}

function parseReadTaskInput(input: unknown, context?: ToolExecutionContext): ReadTaskInput | ToolResult {
  const scoped = parseTaskSelectorInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<ReadTaskInput>
    : {};
  const include = parseInclude(value.include);
  if ("ok" in include) {
    return include;
  }
  const limits = parseTaskDetailLimits(value.limits);
  if (limits !== undefined && "ok" in limits) {
    return limits;
  }
  return {
    sessionId: scoped.sessionId,
    ...(scoped.taskId ? { taskId: scoped.taskId } : {}),
    ...(scoped.branch ? { branch: scoped.branch } : {}),
    ...(include.length > 0 ? { include } : {}),
    ...(limits ? { limits } : {}),
  };
}

function parseReadEvidenceInput(
  input: unknown,
  context?: ToolExecutionContext,
): ReadGitMemoryEvidenceInput | ToolResult {
  const scoped = parseTaskSelectorInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<ReadEvidenceInput>
    : {};
  if (value.runId !== undefined && typeof value.runId !== "string") {
    return invalidInput("runId must be a string.");
  }
  if (value.limit !== undefined && !isValidLimit(value.limit)) {
    return invalidInput("limit must be a positive integer.");
  }
  return {
    sessionId: scoped.sessionId,
    ...(scoped.taskId ? { taskId: scoped.taskId } : {}),
    ...(scoped.branch ? { branch: scoped.branch } : {}),
    ...(trimOptional(value.runId) ? { runId: trimOptional(value.runId) } : {}),
    ...(typeof value.limit === "number" ? { limit: Math.floor(value.limit) } : {}),
  };
}

function parseSearchEvidenceInput(
  input: unknown,
  context?: ToolExecutionContext,
): SearchGitMemoryEvidenceInput | ToolResult {
  const scoped = parseSessionScopedInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<SearchEvidenceInput>
    : {};
  if (typeof value.query !== "string" || value.query.trim().length === 0) {
    return invalidInput("query must be a non-empty string.");
  }
  if (value.taskId !== undefined && typeof value.taskId !== "string") {
    return invalidInput("taskId must be a string.");
  }
  if (value.branch !== undefined && typeof value.branch !== "string") {
    return invalidInput("branch must be a string.");
  }
  if (value.limit !== undefined && !isValidLimit(value.limit)) {
    return invalidInput("limit must be a positive integer.");
  }
  const taskId = trimOptional(value.taskId);
  const branch = trimOptional(value.branch);
  if (taskId && branch) {
    return invalidInput("provide at most one evidence search scope: taskId or branch.");
  }
  return {
    sessionId: scoped.sessionId,
    query: value.query.trim(),
    ...(taskId ? { taskId } : {}),
    ...(branch ? { branch } : {}),
    ...(typeof value.limit === "number" ? { limit: Math.floor(value.limit) } : {}),
  };
}

function parseReadLogInput(input: unknown, context?: ToolExecutionContext): ReadLogInput | ToolResult {
  const scoped = parseSessionScopedInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<ReadLogInput>
    : {};
  if (value.target !== undefined && value.target !== "main" && value.target !== "task") {
    return invalidInput("target must be either main or task.");
  }
  if (value.limit !== undefined && !isValidLimit(value.limit)) {
    return invalidInput("limit must be a positive integer.");
  }

  const target = value.target ?? "main";
  const taskId = trimOptional(value.taskId);
  const branch = trimOptional(value.branch);
  if (target === "main") {
    if (taskId || branch) {
      return invalidInput("taskId and branch are only valid when target is task.");
    }
    return {
      sessionId: scoped.sessionId,
      target,
      ...(typeof value.limit === "number" ? { limit: Math.floor(value.limit) } : {}),
    };
  }

  const selector = validateTaskSelector(taskId, branch);
  if ("ok" in selector) {
    return selector;
  }
  return {
    sessionId: scoped.sessionId,
    target,
    ...(selector.taskId ? { taskId: selector.taskId } : {}),
    ...(selector.branch ? { branch: selector.branch } : {}),
    ...(typeof value.limit === "number" ? { limit: Math.floor(value.limit) } : {}),
  };
}

function parseTaskSelectorInput(input: unknown, context?: ToolExecutionContext): (Required<SessionScopedInput> & {
  taskId?: string;
  branch?: string;
}) | ToolResult {
  const scoped = parseSessionScopedInput(input, context);
  if ("ok" in scoped) {
    return scoped;
  }
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Partial<TaskSelectorInput>
    : {};
  if (value.taskId !== undefined && typeof value.taskId !== "string") {
    return invalidInput("taskId must be a string.");
  }
  if (value.branch !== undefined && typeof value.branch !== "string") {
    return invalidInput("branch must be a string.");
  }
  const selector = validateTaskSelector(trimOptional(value.taskId), trimOptional(value.branch));
  if ("ok" in selector) {
    return selector;
  }
  return {
    sessionId: scoped.sessionId,
    ...(selector.taskId ? { taskId: selector.taskId } : {}),
    ...(selector.branch ? { branch: selector.branch } : {}),
  };
}

function parseSessionScopedInput(input: unknown, context?: ToolExecutionContext): Required<SessionScopedInput> | ToolResult {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
    return invalidInput("expected an object.");
  }
  const value = (input ?? {}) as Partial<SessionScopedInput>;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") {
    return invalidInput("sessionId must be a string.");
  }
  const sessionId = value.sessionId?.trim() || context?.sessionId?.trim();
  if (!sessionId) {
    return invalidInput("sessionId is required when no current tool context session is available.");
  }
  return { sessionId };
}

function validateTaskSelector(
  taskId: string | undefined,
  branch: string | undefined,
): { taskId?: string; branch?: string } | ToolResult {
  if (Boolean(taskId) === Boolean(branch)) {
    return invalidInput("provide exactly one task selector: taskId or branch.");
  }
  return {
    ...(taskId ? { taskId } : {}),
    ...(branch ? { branch } : {}),
  };
}

function parseInclude(input: GitMemoryTaskDetailInclude[] | undefined): GitMemoryTaskDetailInclude[] | ToolResult {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    return invalidInput("include must be an array.");
  }
  const include: GitMemoryTaskDetailInclude[] = [];
  for (const value of input) {
    if (!TASK_DETAIL_INCLUDES.includes(value)) {
      return invalidInput("include contains an unsupported section.");
    }
    if (!include.includes(value)) {
      include.push(value);
    }
  }
  return include;
}

function parseTaskDetailLimits(input: Partial<GitMemoryTaskDetailLimits> | undefined): Partial<GitMemoryTaskDetailLimits> | undefined | ToolResult {
  if (input === undefined) {
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalidInput("limits must be an object when provided.");
  }
  const output: Partial<GitMemoryTaskDetailLimits> = {};
  for (const key of ["runLimit", "actionRunLimit", "actionLimit", "commitLogLimit", "evidenceLimit", "conversationMarkdownCharLimit", "taskMarkdownCharLimit", "runMarkdownCharLimit"] as const) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (!isValidLimit(value)) {
      return invalidInput(`limits.${key} must be a positive integer.`);
    }
    output[key] = Math.floor(value);
  }
  return output;
}

function sessionScopedInputSchema(extraProperties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Optional git-context session id. Defaults to the current run session when available.",
      },
      ...extraProperties,
    },
  };
}

function gitContextReadOnlyAnnotations(): ToolDefinition["annotations"] {
  return commonAnnotations({
    domain: "git_context",
    readOnly: true,
    idempotent: true,
    retrySafe: true,
  });
}

function gitContextTurnMutationAnnotations(): ToolDefinition["annotations"] {
  return commonAnnotations({
    domain: "git_context",
    readOnly: false,
    mutatesWorkspace: true,
    mutatesExternalWorld: false,
    destructive: false,
    idempotent: false,
    retrySafe: false,
  });
}

function withHarnessContext<T extends { memoryState: GitContextMemoryState; context?: unknown }>(
  route: T,
): Omit<T, "memoryState" | "context"> & {
  harnessContext: { contextEngine: ReturnType<typeof buildGitMemoryHarnessContextFromMemoryState> };
} {
  const { memoryState, context: _context, ...publicRoute } = route;
  return {
    ...publicRoute,
    harnessContext: {
      contextEngine: buildGitMemoryHarnessContextFromMemoryState(memoryState),
    },
  };
}

function gitContextSucceededContract(kind: string): ToolDefinition["resultContract"] {
  return succeededContract({
    progressFacts: [{
      kind,
      path: "$.result.structuredContent",
      message: "Git-context operation completed.",
    }],
  });
}

function gitContextReadFailed(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return errorResult({
    code: "GIT_CONTEXT_READ_FAILED",
    message,
    category: "semantic",
    retryable: true,
    recoverable: true,
    suggestedNextActions: ["List git-context sessions and tasks, then retry with a valid session id and task selector."],
  });
}

function gitContextMutationFailed(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return errorResult({
    code: "GIT_CONTEXT_MUTATION_FAILED",
    message,
    category: "semantic",
    retryable: true,
    recoverable: true,
    suggestedNextActions: ["List git-context tasks, then retry with an existing task id or branch selector."],
  });
}

function invalidInput(message: string): ToolResult {
  return errorResult({
    code: "GIT_CONTEXT_INVALID_INPUT",
    message: `Invalid input: ${message}`,
    category: "validation",
    retryable: true,
    recoverable: true,
    suggestedNextActions: ["Retry with a valid git-context session id and supported numeric limits."],
  });
}

function isValidLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function trimRequired(value: unknown, name: string): string | ToolResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidInput(`${name} must be a non-empty string.`);
  }
  return value.trim();
}
