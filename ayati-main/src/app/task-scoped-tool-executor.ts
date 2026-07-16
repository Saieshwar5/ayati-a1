import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { GitContextService, MutationTarget, TaskContextProjection } from "ayati-git-context";
import type {
  MountedToolGroup,
  ToolExecutor,
  ToolGroupMeta,
  ToolRegistryContext,
  ValidationResult,
} from "../skills/tool-executor.js";
import { getToolTaxonomy } from "../skills/tool-taxonomy.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../skills/types.js";
import { canonicalizeAbsolutePath, requireAbsolutePath } from "../skills/workspace-paths.js";
import { isClearlyReadOnlyShellCommand } from "../skills/builtins/shell/read-only-policy.js";

export function createTaskScopedToolExecutor(input: {
  base: ToolExecutor;
  gitContext: GitContextService;
}): ToolExecutor {
  return new TaskScopedToolExecutor(input.base, input.gitContext);
}

class TaskScopedToolExecutor implements ToolExecutor {
  constructor(
    private readonly base: ToolExecutor,
    private readonly gitContext: GitContextService,
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
    const task = active.activeTask;
    if (!task?.checkoutPath || active.run?.run.runId !== context.runId) {
      return await this.base.execute(toolName, originalInput, context);
    }
    const scopedInput = scopeToolInput(toolName, originalInput, task);
    const resourceRoot = task.workingDirectory || task.checkoutPath;
    const scopedContext: ToolExecutionContext = {
      ...context,
      resourceScope: {
        kind: "task",
        rootPath: resourceRoot,
        taskId: task.task.taskId,
      },
    };
    const scopeError = await validateResourceScope(scopedInput, resourceRoot);
    if (scopeError) {
      return taskScopeFailure(scopeError.code, scopeError.message);
    }
    if (taxonomy.effect === "read_only" || taxonomy.effect === "external_mutation") {
      return await this.base.execute(toolName, scopedInput, scopedContext);
    }
    if (await isReadOnlyShellValidation(toolName, scopedInput)) {
      return await this.base.execute(toolName, scopedInput, scopedContext);
    }
    if (toolName === "shell_session_close") {
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
      requestId: randomUUID(),
      sessionId: context.sessionId,
      runId: context.runId,
      taskId: task.task.taskId,
      expectedTaskHead: task.task.head,
      targets,
      at: new Date().toISOString(),
    });
    const result = await this.base.execute(toolName, scopedInput, scopedContext);
    const verified = await this.gitContext.verifyMutation({
      requestId: randomUUID(),
      authorityId: acquired.authority.authorityId,
      lockToken: acquired.authority.lockToken,
      toolStatus: result.ok ? "completed" : "failed",
      at: new Date().toISOString(),
    });
    if (verified.status === "verified") {
      const refreshed = await this.gitContext.getActiveContext({ sessionId: context.sessionId });
      const conversation = refreshed.session?.pendingConversationContext.find(
        (candidate) => candidate.conversation.conversationId === active.run?.run.conversationId,
      );
      if (!conversation?.contentHash) {
        return mutationFailure(result, "Task mutation was verified but its conversation hash is unavailable.");
      }
      await this.gitContext.checkpointMutation({
        requestId: randomUUID(),
        authorityId: acquired.authority.authorityId,
        lockToken: acquired.authority.lockToken,
        purpose: toolName + " step " + String(context.stepNumber ?? 0),
        conversationId: conversation.conversation.conversationId,
        conversationHash: conversation.contentHash,
        at: new Date().toISOString(),
      });
    }
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
  task: TaskContextProjection,
): unknown {
  if (!task.checkoutPath || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const input = structuredClone(value as Record<string, unknown>);
  delete input["allowExternalPath"];
  const scope = (path: unknown): unknown => typeof path === "string" && path.trim() && isAbsolute(path)
    ? resolve(path)
    : path;
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
  if ((toolName === "shell" || toolName.startsWith("shell_")) && !("cwd" in input)) {
    input["cwd"] = task.workingDirectory || task.checkoutPath;
  }
  return input;
}

async function mutationTargets(
  toolName: string,
  value: unknown,
  checkoutPath: string,
): Promise<MutationTarget[]> {
  const requestedTargets = collectMutationTargetInputs(toolName, value);
  const converted = requestedTargets
    .map((target) => ({ ...target, path: relative(checkoutPath, target.path) }))
    .filter((target) => target.path === "." || (!target.path.startsWith("..") && !isAbsolute(target.path)));
  const deduplicated = new Map<string, { path: string; kind?: MutationTarget["kind"] }>();
  for (const target of converted.length > 0 ? converted : [{ path: "." }]) {
    deduplicated.set(target.path, target);
  }
  if (deduplicated.size > 1) deduplicated.delete(".");
  return await Promise.all([...deduplicated.values()].map(async (target) => ({
    path: target.path,
    kind: target.kind ?? await mutationTargetKind(toolName, target.path, checkoutPath),
  })));
}

function collectMutationTargetInputs(
  toolName: string,
  value: unknown,
): Array<{ path: string; kind?: MutationTarget["kind"] }> {
  if (!toolName.startsWith("shell") && toolName !== "python_execute") {
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
  checkoutPath: string,
): Promise<MutationTarget["kind"]> {
  try {
    return (await lstat(resolve(checkoutPath, path))).isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (path === "." || toolName === "create_directory" || toolName.startsWith("shell")) {
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

async function isReadOnlyShellValidation(toolName: string, value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (toolName === "shell") {
    const command = record["cmd"];
    return typeof command === "string" && isClearlyReadOnlyShellCommand(command);
  }
  if (toolName === "shell_run_script" && typeof record["scriptPath"] === "string") {
    const script = await readFile(record["scriptPath"], "utf8").catch(() => undefined);
    return script !== undefined && isClearlyReadOnlyShellCommand(script);
  }
  return false;
}

async function validateResourceScope(
  value: unknown,
  checkoutPath: string,
): Promise<{ code: "ABSOLUTE_PATH_REQUIRED" | "PATH_OUTSIDE_TASK_ROOT"; message: string } | undefined> {
  const canonicalRoot = await canonicalizeAbsolutePath(checkoutPath);
  for (const path of collectPaths(value)) {
    const required = requireAbsolutePath(path);
    if (!required.ok) {
      return {
        code: "ABSOLUTE_PATH_REQUIRED",
        message: `${required.message} The active task workingDirectory is ${canonicalRoot}.`,
      };
    }
    const resolvedPath = await canonicalizeAbsolutePath(required.absolutePath);
    const candidate = relative(canonicalRoot, resolvedPath);
    if (candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))) {
      continue;
    }
    return {
      code: "PATH_OUTSIDE_TASK_ROOT",
      message: `Task resource path is outside the active task workingDirectory ${canonicalRoot}: ${path}`,
    };
  }
  return undefined;
}

function taskScopeFailure(
  code: "TASK_RESOURCE_SCOPE_VIOLATION" | "ABSOLUTE_PATH_REQUIRED" | "PATH_OUTSIDE_TASK_ROOT",
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
            ? "Use the complete absolute path rooted at the active task workingDirectory."
            : "Use an absolute path inside the active task workingDirectory.",
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
