import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  GitContextService,
  ResourceRef,
  ResourceMutationTarget,
  WorkstreamResourceBinding,
} from "ayati-git-context";
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

export function createResourceScopedToolExecutor(input: {
  base: ToolExecutor;
  gitContext: GitContextService;
  workspaceRoot?: string;
}): ToolExecutor {
  return new ResourceScopedToolExecutor(
    input.base,
    input.gitContext,
    resolve(input.workspaceRoot ?? getWorkspaceRoot()),
  );
}

class ResourceScopedToolExecutor implements ToolExecutor {
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
    const binding = activeRun?.runId === context.runId
      ? activeRun.workstreamBinding
      : undefined;
    const workstream = binding
      && active.activeWorkstream?.workstream.workstreamId === binding.workstreamId
      ? active.activeWorkstream
      : undefined;

    if (!binding || !workstream) {
      if (taxonomy.effect !== "read_only") {
        return scopeFailure(
          "R_MUTATION_REQUIRES_WORKSTREAM_BINDING",
          "Mutation requires the current run to be bound to one workstream and request.",
        );
      }
      if (!isObservationalTool(toolName)) {
        return await this.base.execute(toolName, originalInput, context);
      }
      const selectedRoot = await selectUnboundReadRoot(
        active.ingressResources ?? [],
        collectPaths(originalInput),
        this.workspaceRoot,
      );
      if (!selectedRoot) {
        return scopeFailure(
          "PATH_OUTSIDE_WORKSPACE_ROOT",
          "Read-only calls must stay inside the default workspace or one filesystem resource admitted to this run.",
        );
      }
      const scopeError = await validateSingleAuthority(
        originalInput,
        selectedRoot.authorityPath,
        selectedRoot.authorityKind,
        "workspace",
      );
      if (scopeError) return scopeFailure(scopeError.code, scopeError.message);
      const scopedInput = scopeToolInput(
        toolName,
        originalInput,
        selectedRoot.authorityPath,
        selectedRoot.executionRootPath,
      );
      return await this.base.execute(toolName, scopedInput, {
        ...context,
        resourceScope: selectedRoot.resourceId
          ? {
              kind: "resource",
              rootPath: selectedRoot.executionRootPath,
              authorityPath: selectedRoot.authorityPath,
              authorityKind: selectedRoot.authorityKind,
              resourceId: selectedRoot.resourceId,
            }
          : {
              kind: "workspace",
              rootPath: selectedRoot.executionRootPath,
              authorityPath: selectedRoot.authorityPath,
              authorityKind: selectedRoot.authorityKind,
            },
      });
    }

    const filesystemBindings = workstream.resources?.filter(hasFilesystemLocator) ?? [];
    if (filesystemBindings.length === 0) {
      return scopeFailure(
        "WORKSTREAM_RESOURCE_SCOPE_VIOLATION",
        "The selected workstream has no accessible filesystem resource.",
      );
    }
    const requestedPaths = collectPaths(originalInput);
    const rootBinding = await selectCallRoot(filesystemBindings, requestedPaths);
    if (!rootBinding) {
      return scopeFailure(
        "WORKSTREAM_RESOURCE_SCOPE_VIOLATION",
        "One tool call must stay inside one bound filesystem resource. Split cross-resource work into separate calls.",
      );
    }
    const selectedScope = await filesystemScope(rootBinding.resource);
    const scopeError = await validateSingleAuthority(
      originalInput,
      selectedScope.authorityPath,
      selectedScope.authorityKind,
      "resource",
    );
    if (scopeError) return scopeFailure(scopeError.code, scopeError.message);
    const scopedInput = scopeToolInput(
      toolName,
      originalInput,
      selectedScope.authorityPath,
      selectedScope.executionRootPath,
    );
    const scopedContext: ToolExecutionContext = {
      ...context,
      resourceScope: {
        kind: "resource",
        rootPath: selectedScope.executionRootPath,
        authorityPath: selectedScope.authorityPath,
        authorityKind: selectedScope.authorityKind,
        workstreamId: binding.workstreamId,
        resourceId: rootBinding.resource.resourceId,
      },
    };

    if (isObservationalTool(toolName)) {
      return await this.base.execute(toolName, scopedInput, scopedContext);
    }
    if (toolName === "process_poll" || toolName === "process_stop") {
      return await this.base.execute(toolName, scopedInput, scopedContext);
    }
    if (rootBinding.access !== "mutate") {
      return scopeFailure(
        "WORKSTREAM_RESOURCE_MUTATION_DENIED",
        "The selected resource is bound read-only. Bind it with mutate access before changing it.",
      );
    }

    const targets = await mutationTargets(toolName, scopedInput, filesystemBindings);
    if (targets.length === 0) {
      return scopeFailure(
        "WORKSTREAM_RESOURCE_SCOPE_VIOLATION",
        `${toolName} must declare exact file or directory targets before it can mutate resources.`,
      );
    }
    const at = new Date().toISOString();
    const prepared = await this.gitContext.prepareResourceMutation({
      requestId: mutationRequestId(context, "prepare"),
      sessionId: context.sessionId,
      runId: context.runId,
      workstreamId: binding.workstreamId,
      activeRequestId: binding.requestId,
      callId: requireCallId(context),
      tool: toolName,
      effect: taxonomy.effect === "destructive"
        ? "destructive"
        : taxonomy.effect === "external_mutation"
          ? "external_mutation"
          : "workspace_mutation",
      targets,
      at,
    });
    const result = await this.base.execute(toolName, scopedInput, scopedContext);
    const verified = await this.gitContext.verifyResourceMutation({
      requestId: mutationRequestId(context, "verify"),
      operationId: prepared.operationId,
      leaseId: prepared.leaseId,
      lockToken: prepared.lockToken,
      toolStatus: result.ok ? "completed" : "failed",
      at: new Date().toISOString(),
    });
    if (!verified.verified || verified.status === "recovery_required") {
      return mutationFailure(
        result,
        "Resource mutation could not be verified safely; this run now requires recovery.",
      );
    }
    return result;
  }
}

function hasFilesystemLocator(
  binding: WorkstreamResourceBinding,
): binding is WorkstreamResourceBinding & {
  resource: WorkstreamResourceBinding["resource"] & {
    locator: { kind: "filesystem"; path: string };
  };
} {
  return binding.resource.locator.kind === "filesystem";
}

function scopeToolInput(
  toolName: string,
  value: unknown,
  rootShorthandPath: string,
  executionRootPath: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = structuredClone(value as Record<string, unknown>);
  delete input["allowExternalPath"];
  const scope = (path: unknown): unknown => {
    if (typeof path !== "string" || !path.trim() || !isAbsolute(path)) return path;
    return resolve(path) === resolve("/") ? rootShorthandPath : resolve(path);
  };
  for (const key of PATH_KEYS) {
    if (key in input) input[key] = scope(input[key]);
  }
  for (const key of ["paths", "roots", "inputFiles", "sqliteDbPaths"]) {
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
    input["cwd"] = executionRootPath;
  }
  return input;
}

function mutationRequestId(context: ToolExecutionContext, operation: string): string {
  return context.runId + ":" + requireCallId(context) + ":resource-mutation:" + operation;
}

function requireCallId(context: ToolExecutionContext): string {
  const callId = context.callId?.trim();
  if (!callId) throw new Error("Resource mutation requires tool-call identity.");
  return callId;
}

async function mutationTargets(
  toolName: string,
  value: unknown,
  bindings: Array<WorkstreamResourceBinding & {
    resource: WorkstreamResourceBinding["resource"] & {
      locator: { kind: "filesystem"; path: string };
    };
  }>,
): Promise<ResourceMutationTarget[]> {
  const inputs = collectMutationTargetInputs(toolName, value);
  const targets = new Map<string, ResourceMutationTarget>();
  for (const input of inputs) {
    if (!isAbsolute(input.path)) continue;
    const owner = await mostSpecificOwner(bindings.filter((binding) => binding.access === "mutate"), input.path);
    if (!owner) continue;
    const root = owner.resource.locator.path;
    const path = await canonicalizeAbsolutePath(input.path);
    const relativePath = relative(await canonicalizeAbsolutePath(root), path).replaceAll(sep, "/");
    const kind = input.kind ?? await mutationTargetKind(toolName, path);
    const target: ResourceMutationTarget = {
      resourceId: owner.resource.resourceId,
      ...(relativePath ? { relativePath } : {}),
      kind,
      expectedVersionKey: owner.resource.version.key,
    };
    targets.set(owner.resource.resourceId + "\0" + relativePath, target);
  }
  return [...targets.values()];
}

function collectMutationTargetInputs(
  toolName: string,
  value: unknown,
): Array<{ path: string; kind?: ResourceMutationTarget["kind"] }> {
  if (toolName !== "process_run" && toolName !== "process_start"
    && toolName !== "process_send_input" && toolName !== "python_execute") {
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
): Promise<ResourceMutationTarget["kind"]> {
  try {
    return (await lstat(path)).isDirectory() ? "directory" : "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return toolName === "create_directory" ? "directory" : "file";
}

const PATH_KEYS = [
  "path", "from", "to", "source", "destination", "target", "cwd", "workdir",
  "scriptPath", "dbPath", "targetDbPath",
] as const;

function collectPaths(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const input = value as Record<string, unknown>;
  const direct = PATH_KEYS.map((key) => input[key])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const arrays = ["paths", "roots", "files", "edits", "targets", "inputFiles", "sqliteDbPaths"]
    .flatMap((key) => {
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

async function selectCallRoot(
  bindings: Array<WorkstreamResourceBinding & {
    resource: WorkstreamResourceBinding["resource"] & {
      locator: { kind: "filesystem"; path: string };
    };
  }>,
  paths: string[],
): Promise<(typeof bindings)[number] | undefined> {
  const scopedPaths = paths.filter((path) => resolve(path) !== resolve("/"));
  if (scopedPaths.length === 0) {
    return bindings.find((binding) => binding.primary) ?? bindings[0];
  }
  const absolutePaths = scopedPaths.filter(isAbsolute);
  if (absolutePaths.length !== scopedPaths.length) return undefined;
  const candidates: typeof bindings = [];
  for (const binding of bindings) {
    const scope = await filesystemScope(binding.resource);
    const ownsAll = (await Promise.all(absolutePaths.map(async (path) =>
      authorityOwnsPath(
        scope.authorityPath,
        scope.authorityKind,
        await canonicalizeAbsolutePath(path),
      )))).every(Boolean);
    if (ownsAll) candidates.push(binding);
  }
  return candidates.sort((left, right) =>
    right.resource.locator.path.length - left.resource.locator.path.length)[0];
}

async function selectUnboundReadRoot(
  resources: ResourceRef[],
  paths: string[],
  workspaceRoot: string,
): Promise<SelectedFilesystemScope | undefined> {
  const scopedPaths = paths.filter((path) => resolve(path) !== resolve("/"));
  if (scopedPaths.length === 0) {
    return await directoryScope(workspaceRoot);
  }
  const absolutePaths = scopedPaths.filter(isAbsolute);
  if (absolutePaths.length !== scopedPaths.length) return undefined;
  const candidates: Array<{
    authorityPath: string;
    resourceId?: string;
    authorityKind: FilesystemAuthorityKind;
  }> = [{
    authorityPath: workspaceRoot,
    authorityKind: "directory",
  }];
  for (const resource of resources) {
    if (resource.locator.kind !== "filesystem") continue;
    candidates.push({
      authorityPath: resource.locator.path,
      resourceId: resource.resourceId,
      authorityKind: authorityKindForResource(resource),
    });
  }
  const owners: typeof candidates = [];
  for (const candidate of candidates) {
    const authorityPath = await canonicalizeAbsolutePath(candidate.authorityPath);
    const ownsAll = (await Promise.all(absolutePaths.map(async (path) => {
      const resolved = await canonicalizeAbsolutePath(path);
      return authorityOwnsPath(authorityPath, candidate.authorityKind, resolved);
    }))).every(Boolean);
    if (ownsAll) owners.push(candidate);
  }
  const selected = owners.sort((left, right) =>
    right.authorityPath.length - left.authorityPath.length)[0];
  if (!selected) return undefined;
  const authorityPath = await canonicalizeAbsolutePath(selected.authorityPath);
  return {
    authorityPath,
    authorityKind: selected.authorityKind,
    executionRootPath: selected.authorityKind === "directory"
      ? authorityPath
      : dirname(authorityPath),
    ...(selected.resourceId ? { resourceId: selected.resourceId } : {}),
  };
}

async function mostSpecificOwner<T extends WorkstreamResourceBinding & {
  resource: WorkstreamResourceBinding["resource"] & {
    locator: { kind: "filesystem"; path: string };
  };
}>(bindings: T[], path: string): Promise<T | undefined> {
  const candidate = await canonicalizeAbsolutePath(path);
  const owners: T[] = [];
  for (const binding of bindings) {
    const scope = await filesystemScope(binding.resource);
    if (authorityOwnsPath(scope.authorityPath, scope.authorityKind, candidate)) {
      owners.push(binding);
    }
  }
  return owners.sort((left, right) =>
    right.resource.locator.path.length - left.resource.locator.path.length)[0];
}

async function validateSingleAuthority(
  value: unknown,
  authorityPath: string,
  authorityKind: FilesystemAuthorityKind,
  kind: "workspace" | "resource",
): Promise<{
  code: "ABSOLUTE_PATH_REQUIRED" | "PATH_OUTSIDE_RESOURCE_SCOPE" | "PATH_OUTSIDE_WORKSPACE_ROOT";
  message: string;
} | undefined> {
  const root = await canonicalizeAbsolutePath(authorityPath);
  for (const path of collectPaths(value)) {
    const required = requireAbsolutePath(path);
    if (!required.ok) {
      return { code: "ABSOLUTE_PATH_REQUIRED", message: `${required.message} Active root: ${root}.` };
    }
    const requestedPath = resolve(required.absolutePath) === resolve("/")
      ? root
      : await canonicalizeAbsolutePath(required.absolutePath);
    if (!authorityOwnsPath(root, authorityKind, requestedPath)) {
      return {
        code: kind === "resource" ? "PATH_OUTSIDE_RESOURCE_SCOPE" : "PATH_OUTSIDE_WORKSPACE_ROOT",
        message: `Path is outside the active ${kind} root ${root}: ${path}`,
      };
    }
  }
  return undefined;
}

type FilesystemAuthorityKind = "file" | "directory";

interface SelectedFilesystemScope {
  authorityPath: string;
  authorityKind: FilesystemAuthorityKind;
  executionRootPath: string;
  resourceId?: string;
}

function authorityKindForResource(resource: Pick<ResourceRef, "kind">): FilesystemAuthorityKind {
  return resource.kind === "directory" || resource.kind === "git_repository"
    ? "directory"
    : "file";
}

async function filesystemScope(resource: ResourceRef & {
  locator: { kind: "filesystem"; path: string };
}): Promise<SelectedFilesystemScope> {
  const authorityPath = await canonicalizeAbsolutePath(resource.locator.path);
  const authorityKind = authorityKindForResource(resource);
  return {
    authorityPath,
    authorityKind,
    executionRootPath: authorityKind === "directory" ? authorityPath : dirname(authorityPath),
    resourceId: resource.resourceId,
  };
}

async function directoryScope(path: string): Promise<SelectedFilesystemScope> {
  const authorityPath = await canonicalizeAbsolutePath(path);
  return {
    authorityPath,
    authorityKind: "directory",
    executionRootPath: authorityPath,
  };
}

function authorityOwnsPath(
  authorityPath: string,
  authorityKind: FilesystemAuthorityKind,
  candidate: string,
): boolean {
  return authorityKind === "directory"
    ? isWithin(authorityPath, candidate)
    : resolve(authorityPath) === resolve(candidate);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

function scopeFailure(
  code:
    | "WORKSTREAM_RESOURCE_SCOPE_VIOLATION"
    | "WORKSTREAM_RESOURCE_MUTATION_DENIED"
    | "ABSOLUTE_PATH_REQUIRED"
    | "PATH_OUTSIDE_RESOURCE_SCOPE"
    | "PATH_OUTSIDE_WORKSPACE_ROOT"
    | "R_MUTATION_REQUIRES_WORKSTREAM_BINDING",
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
          code === "R_MUTATION_REQUIRES_WORKSTREAM_BINDING"
            ? "Create or activate the correct workstream, then make a fresh mutation decision."
            : "Use an absolute path inside one resource bound to the active workstream.",
        ],
      },
    },
  };
}

function mutationFailure(result: ToolResult, message: string): ToolResult {
  return { ...result, ok: false, error: [result.error, message].filter(Boolean).join(" ") };
}
