import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";
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
    const repeatedRoot = findRepeatedTaskRoot(originalInput, task.checkoutPath);
    if (repeatedRoot) {
      return taskScopeFailure(
        "TASK_ROOT_REPEATED",
        `Task paths are already relative to the active task root. Use '${repeatedRoot.suggestedPath}' instead of '${repeatedRoot.path}'.`,
      );
    }
    const scopedInput = scopeToolInput(toolName, originalInput, task);
    const scopedContext: ToolExecutionContext = {
      ...context,
      resourceScope: {
        kind: "task",
        rootPath: task.checkoutPath,
        taskId: task.task.taskId,
      },
    };
    if (taxonomy.effect === "read_only" || taxonomy.effect === "external_mutation") {
      return await this.base.execute(toolName, scopedInput, scopedContext);
    }
    if (isReadOnlyShellValidation(toolName, scopedInput)) {
      return await this.base.execute(toolName, scopedInput, scopedContext);
    }
    const scopeError = validateMutationScope(scopedInput, task.checkoutPath);
    if (scopeError) {
      return taskScopeFailure("TASK_RESOURCE_SCOPE_VIOLATION", scopeError);
    }
    const targets = await mutationTargets(toolName, scopedInput, task.checkoutPath);
    if (targets.some((target) => target.path === ".")) {
      return taskScopeFailure(
        "TASK_RESOURCE_SCOPE_VIOLATION",
        `${toolName} must name a bounded task-relative file or subdirectory before mutation authority can be acquired.`,
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
  const scope = (path: unknown): unknown => typeof path === "string" && path.trim()
    ? scopePath(path, task.checkoutPath!)
    : path;
  for (const key of ["path", "from", "to", "source", "destination", "target", "cwd", "workdir", "scriptPath"]) {
    if (key in input) input[key] = scope(input[key]);
  }
  for (const key of ["paths", "roots"]) {
    if (Array.isArray(input[key])) input[key] = (input[key] as unknown[]).map(scope);
  }
  for (const key of ["files", "edits"]) {
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
    input["cwd"] = task.checkoutPath;
  }
  return input;
}

function scopePath(path: string, checkoutPath: string): string {
  if (isAbsolute(path)) return path;
  return resolve(checkoutPath, path);
}

async function mutationTargets(
  toolName: string,
  value: unknown,
  checkoutPath: string,
): Promise<MutationTarget[]> {
  const paths = collectPaths(value)
    .map((path) => isAbsolute(path) ? relative(checkoutPath, path) : path)
    .filter((path) => path === "." || (!path.startsWith("..") && !isAbsolute(path)));
  const uniquePaths = [...new Set(paths.length > 0 ? paths : ["."])];
  const unique = uniquePaths.length > 1
    ? uniquePaths.filter((path) => path !== ".")
    : uniquePaths;
  return await Promise.all(unique.map(async (path) => ({
    path,
    kind: await mutationTargetKind(toolName, path, checkoutPath),
  })));
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
  const direct = ["path", "from", "to", "source", "destination", "target", "cwd", "workdir", "scriptPath"]
    .map((key) => input[key])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const arrays = ["paths", "files", "edits"].flatMap((key) => {
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

function isReadOnlyShellValidation(toolName: string, value: unknown): boolean {
  if (toolName !== "shell" || !value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const command = (value as Record<string, unknown>)["cmd"];
  if (typeof command !== "string" || /[;&|`\n\r]|\$\(/.test(command)) {
    return false;
  }
  return /^\s*node\s+(?:--check|-c)\s+(?:"[^"]+"|'[^']+'|[^\s]+)\s*$/.test(command);
}

function validateMutationScope(value: unknown, checkoutPath: string): string | undefined {
  for (const path of collectPaths(value)) {
    const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(checkoutPath, path);
    const candidate = relative(checkoutPath, resolvedPath);
    if (candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))) {
      continue;
    }
    return `Task mutation path is outside the active task checkout: ${path}`;
  }
  return undefined;
}

function findRepeatedTaskRoot(
  value: unknown,
  checkoutPath: string,
): { path: string; suggestedPath: string } | undefined {
  const rootName = basename(resolve(checkoutPath));
  if (!rootName) return undefined;
  for (const path of collectPaths(value)) {
    if (isAbsolute(path)) continue;
    const normalizedPath = normalize(path).replace(new RegExp(`^\\.${escapeRegExp(sep)}+`), "");
    if (normalizedPath !== rootName && !normalizedPath.startsWith(rootName + sep)) {
      continue;
    }
    const suggestedPath = normalizedPath === rootName
      ? "."
      : normalizedPath.slice(rootName.length + 1);
    return { path, suggestedPath };
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function taskScopeFailure(
  code: "TASK_RESOURCE_SCOPE_VIOLATION" | "TASK_ROOT_REPEATED",
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
        category: code === "TASK_ROOT_REPEATED" ? "validation" : "permission",
        code,
        message,
        retryable: true,
        recoverable: true,
        suggestedNextActions: [
          code === "TASK_ROOT_REPEATED"
            ? "Remove the repeated task directory prefix and retry with the suggested task-relative path."
            : "Use a task-relative path inside the active task checkout.",
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
