import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ContextEngineService,
  ResourceRef,
  ResourceMutationTarget,
  WorkstreamResourceBinding,
} from "ayati-context-engine";
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
import {
  collectToolPaths,
  DEFAULT_FILESYSTEM_ACCESS_POLICY,
  isMachineFilesystemReadTool,
  resolveWorkspaceMutationInput,
  selectFilesystemMutationRoot,
  scopeToolInput,
  usesSelectedFilesystemMutationRoot,
  validateMachineReadPaths,
  validateWorkspaceMutationPaths,
  type FilesystemAccessPolicy,
} from "./filesystem-access-policy.js";
import {
  attachFilesystemMutationVerification,
  FilesystemMutationPreparationError,
  prepareFilesystemMutationVerification,
  verifyFilesystemMutation,
} from "./filesystem-mutation-verifier.js";
import { resourceScopeFailure as scopeFailure } from "./resource-scope-failure.js";

export function createResourceScopedToolExecutor(input: {
  base: ToolExecutor;
  contextEngine: ContextEngineService;
  workspaceRoot?: string;
  filesystemAccess?: FilesystemAccessPolicy;
}): ToolExecutor {
  return new ResourceScopedToolExecutor(
    input.base,
    input.contextEngine,
    resolve(input.workspaceRoot ?? getWorkspaceRoot()),
    input.filesystemAccess ?? DEFAULT_FILESYSTEM_ACCESS_POLICY,
  );
}

class ResourceScopedToolExecutor implements ToolExecutor {
  constructor(
    private readonly base: ToolExecutor,
    private readonly contextEngine: ContextEngineService,
    private readonly workspaceRoot: string,
    private readonly filesystemAccess: FilesystemAccessPolicy,
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
    const definition = this.base.definitions(context).find((tool) => tool.name === toolName);
    const selectedFilesystemMutation = taxonomy?.effect !== "read_only"
      && usesSelectedFilesystemMutationRoot(toolName)
      && Boolean(context?.filesystemMutationRoots?.length);
    if (
      !taxonomy
      || taxonomy.effect === "context_mutation"
      || definition?.annotations?.domain === "context"
    ) {
      return await this.base.execute(toolName, originalInput, context);
    }

    if (isMachineFilesystemReadTool(toolName, definition, this.filesystemAccess)) {
      const pathFailure = validateMachineReadPaths(toolName, originalInput);
      if (pathFailure) {
        return scopeFailure(
          pathFailure.code,
          pathFailure.message,
          pathFailure.target,
        );
      }
      const scopedInput = scopeToolInput(
        toolName,
        originalInput,
        this.workspaceRoot,
      );
      return await this.base.execute(toolName, scopedInput, {
        ...context,
        resourceScope: {
          kind: "machine_read",
          rootPath: this.workspaceRoot,
          authorityPath: "/",
          authorityKind: "directory",
        },
      });
    }

    const executionInput = taxonomy.effect === "read_only"
      ? originalInput
      : resolveWorkspaceMutationInput(toolName, originalInput, this.workspaceRoot);

    if (
      taxonomy.effect !== "read_only"
      && this.filesystemAccess.mutationScope === "workspace"
      && !selectedFilesystemMutation
    ) {
      const pathFailure = await validateWorkspaceMutationPaths({
        toolName,
        value: executionInput,
        workspaceRoot: this.workspaceRoot,
      });
      if (pathFailure) {
        return scopeFailure(
          pathFailure.code,
          pathFailure.message,
          pathFailure.target,
        );
      }
    }

    if (!context?.sessionId || !context.runId) {
      if (taxonomy.effect !== "read_only") {
        return scopeFailure(
          "R_MUTATION_REQUIRES_WORKSTREAM_BINDING",
          "Mutation requires a run, session, and authoritative workstream binding.",
        );
      }
      return await this.base.execute(toolName, executionInput, context);
    }

    const active = await this.contextEngine.getAgentContext({ streamId: context.sessionId });
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
        collectToolPaths(executionInput),
        this.workspaceRoot,
      );
      if (!selectedRoot) {
        return scopeFailure(
          "PATH_OUTSIDE_WORKSPACE_ROOT",
          "Read-only calls must stay inside the default workspace or one filesystem resource admitted to this run.",
        );
      }
      const scopeError = await validateSingleAuthority(
        executionInput,
        selectedRoot.authorityPath,
        selectedRoot.authorityKind,
        "workspace",
      );
      if (scopeError) return scopeFailure(scopeError.code, scopeError.message);
      const scopedInput = scopeToolInput(
        toolName,
        executionInput,
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

    if (selectedFilesystemMutation) {
      const selected = await selectFilesystemMutationRoot({
        toolName,
        value: executionInput,
        roots: context.filesystemMutationRoots ?? [],
      });
      if ("failure" in selected) {
        return scopeFailure(
          selected.failure.code,
          selected.failure.message,
          selected.failure.target,
        );
      }
      const scopedInput = scopeToolInput(
        toolName,
        executionInput,
        selected.selection.executionRootPath,
      );
      let preparedVerification;
      try {
        preparedVerification = await prepareFilesystemMutationVerification(
          toolName,
          scopedInput,
        );
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "Target-local filesystem verification could not be prepared.";
        return filesystemVerificationPreparationFailure(
          message,
          error instanceof FilesystemMutationPreparationError
            ? {
                code: error.code,
                target: error.target,
              }
            : undefined,
        );
      }
      if (toolName === "process_run" && !preparedVerification) {
        return scopeFailure(
          "WORKSTREAM_RESOURCE_SCOPE_VIOLATION",
          "process_run must declare exact file or directory targets before it can run inside a current-run creation scope.",
        );
      }
      const result = await this.base.execute(toolName, scopedInput, {
        ...context,
        ...(preparedVerification
          ? {
              filesystemTargetPreconditions:
                preparedVerification.targetPreconditions,
            }
          : {}),
        resourceScope: {
          kind: "mutation_root",
          rootPath: selected.selection.executionRootPath,
          authorityPath: selected.selection.authorityPath,
          authorityKind: selected.selection.authorityKind,
          mutationAuthorities: selected.selection.mutationAuthorities,
          workstreamId: binding.workstreamId,
        },
      });
      if (!preparedVerification) return result;
      try {
        const verification = await verifyFilesystemMutation(
          preparedVerification,
          result,
        );
        return attachFilesystemMutationVerification(result, verification);
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "Target-local filesystem verification failed.";
        return filesystemVerificationFailure(result, message);
      }
    }

    const filesystemBindings = workstream.resources?.filter(hasFilesystemLocator) ?? [];
    if (filesystemBindings.length === 0) {
      return scopeFailure(
        "WORKSTREAM_RESOURCE_SCOPE_VIOLATION",
        "The selected workstream has no accessible filesystem resource.",
      );
    }
    const requestedPaths = collectToolPaths(executionInput);
    const rootBinding = await selectCallRoot(filesystemBindings, requestedPaths);
    if (!rootBinding) {
      return scopeFailure(
        "WORKSTREAM_RESOURCE_SCOPE_VIOLATION",
        "One tool call must stay inside one bound filesystem resource. Split cross-resource work into separate calls.",
      );
    }
    const selectedScope = await filesystemScope(rootBinding.resource);
    const scopeError = await validateSingleAuthority(
      executionInput,
      selectedScope.authorityPath,
      selectedScope.authorityKind,
      "resource",
    );
    if (scopeError) return scopeFailure(scopeError.code, scopeError.message);
    const scopedInput = scopeToolInput(
      toolName,
      executionInput,
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
    if (toolName === "process_start" || toolName === "process_send_input") {
      return await this.base.execute(toolName, scopedInput, scopedContext);
    }

    const targets = await mutationTargets(toolName, scopedInput, filesystemBindings);
    if (targets.length === 0) {
      return scopeFailure(
        "WORKSTREAM_RESOURCE_SCOPE_VIOLATION",
        `${toolName} must declare exact file or directory targets before it can mutate resources.`,
      );
    }
    const at = new Date().toISOString();
    const prepared = await this.contextEngine.prepareResourceMutation({
      requestId: mutationRequestId(context, "prepare"),
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
    const verified = await this.contextEngine.verifyResourceMutation({
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
    return collectToolPaths(value).map((path) => ({ path }));
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

async function selectCallRoot(
  bindings: Array<WorkstreamResourceBinding & {
    resource: WorkstreamResourceBinding["resource"] & {
      locator: { kind: "filesystem"; path: string };
    };
  }>,
  paths: string[],
): Promise<(typeof bindings)[number] | undefined> {
  if (paths.length === 0) {
    return bindings.find((binding) => binding.primary) ?? bindings[0];
  }
  const absolutePaths = paths.filter(isAbsolute);
  if (absolutePaths.length !== paths.length) return undefined;
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
  if (paths.length === 0) {
    return await directoryScope(workspaceRoot);
  }
  const absolutePaths = paths.filter(isAbsolute);
  if (absolutePaths.length !== paths.length) return undefined;
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
  for (const path of collectToolPaths(value)) {
    const required = requireAbsolutePath(path);
    if (!required.ok) {
      return { code: "ABSOLUTE_PATH_REQUIRED", message: `${required.message} Active root: ${root}.` };
    }
    const requestedPath = await canonicalizeAbsolutePath(required.absolutePath);
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

function mutationFailure(result: ToolResult, message: string): ToolResult {
  return { ...result, ok: false, error: [result.error, message].filter(Boolean).join(" ") };
}

function filesystemVerificationPreparationFailure(
  message: string,
  known?: {
    code:
      | "DUPLICATE_TARGET_PATH"
      | "WRITE_TARGET_NOT_REGULAR_FILE"
      | "PATCH_TARGET_NOT_REGULAR_FILE";
    target: string;
  },
): ToolResult {
  const code = known?.code ?? "FILESYSTEM_MUTATION_VERIFICATION_UNAVAILABLE";
  const category = code === "DUPLICATE_TARGET_PATH"
    ? "conflict"
    : code === "WRITE_TARGET_NOT_REGULAR_FILE"
      || code === "PATCH_TARGET_NOT_REGULAR_FILE"
      ? "semantic"
      : "validation";
  return {
    ok: false,
    error: message,
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code,
      message,
      error: {
        category,
        code,
        message,
        retryable: code === "DUPLICATE_TARGET_PATH",
        recoverable: true,
        ...(known ? { target: known.target } : {}),
        suggestedNextActions: [
          code === "DUPLICATE_TARGET_PATH"
            ? "Keep one entry for each canonical absolute target path and retry."
            : "Inspect the canonical target path and retry only after resolving the verification problem.",
        ],
      },
    },
  };
}

function filesystemVerificationFailure(result: ToolResult, detail: string): ToolResult {
  const message = `Filesystem mutation verification failed after execution: ${detail}`;
  return {
    ...result,
    ok: false,
    error: [result.error, message].filter(Boolean).join(" "),
    v2: {
      transportOk: result.v2?.transportOk ?? true,
      operationStatus: "failed",
      code: "FILESYSTEM_MUTATION_VERIFICATION_FAILED",
      message,
      ...(result.v2?.structuredContent !== undefined
        ? { structuredContent: result.v2.structuredContent }
        : {}),
      ...(result.v2?.artifacts ? { artifacts: result.v2.artifacts } : {}),
      diagnostics: {
        ...result.v2?.diagnostics,
        verificationError: detail,
      },
      error: {
        category: "unknown",
        code: "FILESYSTEM_MUTATION_VERIFICATION_FAILED",
        message,
        retryable: false,
        recoverable: true,
        suggestedNextActions: [
          "Inspect the affected paths before making another mutation.",
        ],
      },
    },
  };
}
