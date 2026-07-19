import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { GitContextService, MutationTarget } from "ayati-git-context";
import type {
  MountedToolGroup,
  ToolExecutor,
  ToolGroupMeta,
  ToolRegistryContext,
  ValidationResult,
} from "../skills/tool-executor.js";
import { getToolTaxonomy, isObservationalTool } from "../skills/tool-taxonomy.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../skills/types.js";
import {
  canonicalizeAbsolutePath,
  getWorkspaceRoot,
  requireAbsolutePath,
} from "../skills/workspace-paths.js";

export function createTaskScopedToolExecutor(input: {
  base: ToolExecutor;
  gitContext: GitContextService;
  workspaceRoot?: string;
}): ToolExecutor {
  return new TaskScopedToolExecutor(
    input.base,
    input.gitContext,
    resolve(input.workspaceRoot ?? getWorkspaceRoot()),
  );
}

class TaskScopedToolExecutor implements ToolExecutor {
  constructor(
    private readonly base: ToolExecutor,
    private readonly gitContext: GitContextService,
    private readonly workspaceRoot: string,
  ) {}

  list(context?: ToolRegistryContext): string[] {
    return this.base.list(context);
  }

  definitions(context?: ToolRegistryContext): ToolDefinition[] {
    return this.base.definitions(context);
  }

  validate(toolName: string, input: unknown, context?: ToolRegistryContext): ValidationResult {
    return this.base.validate(toolName, input, context);
  }

  mount(groupId: string, tools: ToolDefinition[], meta?: Partial<ToolGroupMeta>): void {
    this.base.mount?.(groupId, tools, meta);
  }

  unmount(groupId: string): void {
    this.base.unmount?.(groupId);
  }

  listMountedGroups(context?: ToolRegistryContext): MountedToolGroup[] {
    return this.base.listMountedGroups?.(context) ?? [];
  }

  cleanupExpired(context: ToolRegistryContext): string[] {
    return this.base.cleanupExpired?.(context) ?? [];
  }

  async execute(
    toolName: string,
    originalInput: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const taxonomy = getToolTaxonomy(toolName);
    if (!context?.sessionId || !context.runId || !taxonomy || taxonomy.effect === "context_mutation") {
      return await this.base.execute(toolName, originalInput, context);
    }
    const active = await this.gitContext.getActiveContext({ sessionId: context.sessionId });
    const activeRun = active.run?.run;
    const taskBinding = activeRun?.runId === context.runId
      ? activeRun.taskBinding
      : undefined;
    const task = taskBinding
      && active.activeTask?.task.taskId === taskBinding.taskId
      ? active.activeTask
      : undefined;
    if (!task) {
      if (taxonomy.effect !== "read_only") {
        return taskScopeFailure(
          "R_MUTATION_REQUIRES_TASK_BINDING",
          "Mutation requires the current run to be bound to one task and request.",
        );
      }
      if (!isObservationalTool(toolName)) {
        return await this.base.execute(toolName, originalInput, context);
      }
      const scopedInput = scopeToolInput(toolName, originalInput, this.workspaceRoot);
      const scopeError = await validateResourceScope(scopedInput, this.workspaceRoot, "workspace");
      if (scopeError) {
        return taskScopeFailure(scopeError.code, scopeError.message);
      }
      return await this.base.execute(toolName, scopedInput, {
        ...context,
        resourceScope: {
          kind: "workspace",
          rootPath: this.workspaceRoot,
        },
      });
    }
    if (!taskBinding) {
      return taskScopeFailure(
        "TASK_RESOURCE_SCOPE_VIOLATION",
        "Task execution requires a task-bound run with one active request.",
      );
    }
    const resourceRoot = task.workingDirectory;
    if (!resourceRoot) {
      return taskScopeFailure(
        "TASK_RESOURCE_SCOPE_VIOLATION",
        "The selected task has no stable working directory.",
      );
    }
    const scopedInput = scopeToolInput(toolName, originalInput, resourceRoot);
    const scopedContext: ToolExecutionContext = {
      ...context,
      resourceScope: {
        kind: "task",
        rootPath: resourceRoot,
        taskId: task.task.taskId,
      },
    };
    const scopeError = await validateResourceScope(scopedInput, resourceRoot, "task");
    if (scopeError) {
      return taskScopeFailure(scopeError.code, scopeError.message);
    }
    if (isObservationalTool(toolName)) {
      return await this.base.execute(toolName, scopedInput, scopedContext);
    }
    if (taxonomy.effect === "external_mutation") {
      const acquired = await this.gitContext.acquireMutationAuthority({
        requestId: mutationRequestId(context, "authority"),
        sessionId: context.sessionId,
        runId: context.runId,
        taskId: task.task.taskId,
        taskRequestId: taskBinding.taskRequestId,
        expectedTaskHead: task.task.head,
        targets: [],
        at: new Date().toISOString(),
      });
      const result = await this.base.execute(toolName, scopedInput, scopedContext);
      const verified = await this.gitContext.verifyMutation({
        requestId: mutationRequestId(context, "verification"),
        authorityId: acquired.authority.authorityId,
        lockToken: acquired.authority.lockToken,
        // A successful operation may still be semantically inconclusive. It
        // receives a context-only commit, while task_completion continues to
        // require the tool-owned deterministic verification facts.
        toolStatus: result.ok ? "completed" : "failed",
        at: new Date().toISOString(),
      });
      if (!verified.verified || verified.status === "recovery_required") {
        return mutationFailure(result, "External outcome could not be bound to verified task context.");
      }
      return result;
    }
    if (toolName === "process_poll" || toolName === "process_stop") {
      return await this.base.execute(toolName, scopedInput, scopedContext);
    }
    const targets = await mutationTargets(toolName, scopedInput, resourceRoot);
    if (targets.some((target) => target.path === ".")) {
      return taskScopeFailure(
        "TASK_RESOURCE_SCOPE_VIOLATION",
        `${toolName} must name a bounded absolute file or subdirectory inside ${resourceRoot} before mutation authority can be acquired.`,
      );
    }
    const acquired = await this.gitContext.acquireMutationAuthority({
      requestId: mutationRequestId(context, "authority"),
      sessionId: context.sessionId,
      runId: context.runId,
      taskId: task.task.taskId,
      taskRequestId: taskBinding.taskRequestId,
      expectedTaskHead: task.task.head,
      targets,
      at: new Date().toISOString(),
    });
    const result = await this.base.execute(toolName, scopedInput, scopedContext);
    const verified = await this.gitContext.verifyMutation({
      requestId: mutationRequestId(context, "verification"),
      authorityId: acquired.authority.authorityId,
      lockToken: acquired.authority.lockToken,
      toolStatus: result.ok ? "completed" : "failed",
      at: new Date().toISOString(),
    });
    if (!verified.verified || verified.status === "recovery_required") {
      return mutationFailure(
        result,
        "Task mutation verification failed: " + verified.outcome + ".",
      );
    }
    return result;
  }
}

function scopeToolInput(
  toolName: string,
  value: unknown,
  resourceRoot: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const input = structuredClone(value as Record<string, unknown>);
  delete input["allowExternalPath"];
  const scope = (path: unknown): unknown => {
    if (typeof path !== "string" || !path.trim() || !isAbsolute(path)) {
      return path;
    }
    const resolvedPath = resolve(path);
    return resolvedPath === resolve("/") ? resourceRoot : resolvedPath;
  };
  for (const key of ["path", "from", "to", "source", "destination", "target", "cwd", "workdir", "scriptPath", "dbPath", "targetDbPath"]) {
    if (key in input) input[key] = scope(input[key]);
  }
  for (const key of ["paths", "roots"]) {
    if (Array.isArray(input[key])) input[key] = (input[key] as unknown[]).map(scope);
  }
  for (const key of ["files", "edits", "targets"]) {
    if (!Array.isArray(input[key])) continue;
    input[key] = (input[key] as unknown[]).map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const record = { ...(entry as Record<string, unknown>) };
      for (const pathKey of ["path", "from", "to"]) {
        if (pathKey in record) record[pathKey] = scope(record[pathKey]);
      }
      return record;
    });
  }
  if ((toolName === "process_run" || toolName === "process_start") && !("cwd" in input)) {
    input["cwd"] = resourceRoot;
  }
  return input;
}

function mutationRequestId(context: ToolExecutionContext, operation: string): string {
  const callId = context.callId?.trim();
  if (!context.runId || !callId) {
    throw new Error("Mutation authority requires run and tool-call identity.");
  }
  return context.runId + ":" + callId + ":" + operation;
}

async function mutationTargets(
  toolName: string,
  value: unknown,
  workingDirectory: string,
): Promise<MutationTarget[]> {
  const requestedTargets = collectMutationTargetInputs(toolName, value);
  const converted = requestedTargets
    .map((target) => ({ ...target, path: relative(workingDirectory, target.path) }))
    .filter((target) => target.path === "." || (!target.path.startsWith("..") && !isAbsolute(target.path)));
  const deduplicated = new Map<string, { path: string; kind?: MutationTarget["kind"] }>();
  const fallbackTargets = toolName === "process_run"
    ? []
    : [{ path: "." }];
  for (const target of converted.length > 0 ? converted : fallbackTargets) {
    deduplicated.set(target.path, target);
  }
  if (deduplicated.size > 1) deduplicated.delete(".");
  return await Promise.all([...deduplicated.values()].map(async (target) => ({
    path: target.path,
    kind: target.kind ?? await mutationTargetKind(toolName, target.path, workingDirectory),
  })));
}

function collectMutationTargetInputs(
  toolName: string,
  value: unknown,
): Array<{ path: string; kind?: MutationTarget["kind"] }> {
  if (
    toolName !== "process_run"
    && toolName !== "process_start"
    && toolName !== "process_send_input"
    && toolName !== "python_execute"
  ) {
    return collectPaths(value).map((path) => ({ path }));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const targets = (value as Record<string, unknown>)["targets"];
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const target = entry as Record<string, unknown>;
    if (typeof target["path"] !== "string") return [];
    const kind = target["kind"] === "file" || target["kind"] === "directory"
      ? target["kind"]
      : undefined;
    return [{ path: target["path"], ...(kind ? { kind } : {}) }];
  });
}

async function mutationTargetKind(
  toolName: string,
  path: string,
  workingDirectory: string,
): Promise<MutationTarget["kind"]> {
  try {
    return (await lstat(resolve(workingDirectory, path))).isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (path === "." || toolName === "create_directory" || toolName === "process_run" || toolName === "process_start") {
    return "directory";
  }
  return "file";
}

function collectPaths(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const input = value as Record<string, unknown>;
  const direct = ["path", "from", "to", "source", "destination", "target", "cwd", "workdir", "scriptPath", "dbPath", "targetDbPath"]
    .map((key) => input[key])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const arrays = ["paths", "roots", "files", "edits", "targets", "inputFiles", "sqliteDbPaths"].flatMap((key) => {
    const entries = input[key];
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      return [record["path"], record["from"], record["to"]]
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    });
  });
  return [...direct, ...arrays];
}

async function validateResourceScope(
  value: unknown,
  resourceRoot: string,
  resourceKind: "workspace" | "task",
): Promise<{
  code: "ABSOLUTE_PATH_REQUIRED" | "PATH_OUTSIDE_TASK_ROOT" | "PATH_OUTSIDE_WORKSPACE_ROOT";
  message: string;
} | undefined> {
  const canonicalRoot = await canonicalizeAbsolutePath(resourceRoot);
  const rootLabel = resourceKind === "task" ? "active task workingDirectory" : "configured workspace root";
  for (const path of collectPaths(value)) {
    const required = requireAbsolutePath(path);
    if (!required.ok) {
      return {
        code: "ABSOLUTE_PATH_REQUIRED",
        message: `${required.message} The ${rootLabel} is ${canonicalRoot}.`,
      };
    }
    const resolvedPath = await canonicalizeAbsolutePath(required.absolutePath);
    const candidate = relative(canonicalRoot, resolvedPath);
    if (candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))) {
      continue;
    }
    return {
      code: resourceKind === "task" ? "PATH_OUTSIDE_TASK_ROOT" : "PATH_OUTSIDE_WORKSPACE_ROOT",
      message: `Resource path is outside the ${rootLabel} ${canonicalRoot}: ${path}`,
    };
  }
  return undefined;
}

function taskScopeFailure(
  code:
    | "TASK_RESOURCE_SCOPE_VIOLATION"
    | "ABSOLUTE_PATH_REQUIRED"
    | "PATH_OUTSIDE_TASK_ROOT"
    | "PATH_OUTSIDE_WORKSPACE_ROOT"
    | "R_MUTATION_REQUIRES_TASK_BINDING",
  message: string,
): ToolResult {
  return {
    ok: false,
    error: message,
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code,
      message,
      error: {
        category: code === "ABSOLUTE_PATH_REQUIRED" ? "validation" : "permission",
        code,
        message,
        retryable: true,
        recoverable: true,
        suggestedNextActions: [
          code === "ABSOLUTE_PATH_REQUIRED"
            ? "Use the complete absolute path rooted at the active resource scope."
            : "Use an absolute path inside the active resource scope.",
          "Use the task resource binding flow when the user explicitly requested another output location.",
        ],
      },
    },
  };
}

function mutationFailure(result: ToolResult, message: string): ToolResult {
  return {
    ...result,
    ok: false,
    error: [result.error, message].filter(Boolean).join(" "),
  };
}
