import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  BindResourcesForRunRequest,
  BindResourcesForRunResponse,
  FindResourcesRequest,
  FindResourcesResponse,
  InspectResourceForRunRequest,
  InspectResourceForRunResponse,
  ResourceAdmission,
  ResourceRef,
  AgentStreamResourcesProjection,
  WorkstreamResourceBinding,
  WorkstreamCompletionRecord,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  executeIdempotent,
  readCompletedIdempotent,
} from "../database/idempotency.js";
import { ContextEngineServiceError } from "../errors.js";
import {
  admitMessageResources,
  bindResourcesToWorkstream,
  findResources,
  mutationEligible,
  readResource,
  readResourceByLocator,
  recordResourceAccess,
  readAgentStreamResourcesProjection,
  readWorkstreamResourceBindings,
  upsertResource,
  resourceIdForLocator,
  resourceLocatorKey,
  type ObservedResourceAdmission,
} from "../repositories/resource-records.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { invalidateStaleReusableObservations } from "../repositories/reusable-observation-records.js";
import { ManagedResourceStore } from "../resources/managed-resource-store.js";
import { observeResource } from "../resources/resource-observation.js";
import { canonicalizeWorkstreamResourceBindings } from "../resources/workstream-resource-binding-policy.js";
import { workstreamSlug } from "../workstreams/workstream-repository-layout.js";

export interface ResourceCatalogServiceOptions {
  database: ContextDatabase;
  rootDirectory: string;
}

export class ResourceCatalogService {
  private readonly database: ContextDatabase;
  private readonly rootDirectory: string;
  private readonly outputRoot: string;
  private readonly store: ManagedResourceStore;

  constructor(options: ResourceCatalogServiceOptions) {
    this.database = options.database;
    this.rootDirectory = resolve(options.rootDirectory);
    this.outputRoot = join(this.rootDirectory, "workspace");
    this.store = new ManagedResourceStore(join(this.rootDirectory, ".ayati", "resources"));
  }

  async normalizeIngressAdmissions(
    admissions: ResourceAdmission[] | undefined,
    at: string,
  ): Promise<ObservedResourceAdmission[]> {
    const result: ObservedResourceAdmission[] = [];
    for (const admission of admissions ?? []) {
      if (admission.origin === "user_attachment" && admission.locator.kind === "filesystem") {
        const stored = await this.store.storeFile(admission.locator.path);
        if (admission.version?.sha256 && admission.version.sha256 !== stored.contentHash) {
          throw new ContextEngineServiceError({
            code: "RESOURCE_VERSION_MISMATCH",
            message: "Attachment bytes changed after the caller observed them.",
            details: { admissionId: admission.admissionId },
          });
        }
        const observed = await observeResource(
          { kind: "managed_blob", resourceId: stored.resourceId },
          {
            at,
            kind: admission.kind,
            managedBlobPath: stored.storedPath,
          },
        );
        result.push({
          ...admission,
          locator: observed.locator,
          displayName: admission.displayName || stored.displayName,
          version: observed.version,
          ...(admission.mediaType ?? observed.mediaType
            ? { mediaType: admission.mediaType ?? observed.mediaType }
            : {}),
        });
      } else {
        const observed = await observeResource(admission.locator, {
          at,
          kind: admission.kind,
        });
        result.push({
          ...admission,
          locator: observed.locator,
          displayName: admission.displayName || observed.displayName,
          version: observed.version,
          ...(admission.mediaType ?? observed.mediaType
            ? { mediaType: admission.mediaType ?? observed.mediaType }
            : {}),
        });
      }
    }
    return result;
  }

  admitPreparedTurn(input: {
    messageId: string;
    runId: string;
    admissions: ObservedResourceAdmission[];
    at: string;
  }): ResourceRef[] {
    return admitMessageResources(this.database, input);
  }

  async inspect(input: InspectResourceForRunRequest): Promise<InspectResourceForRunResponse> {
    const replay = readCompletedIdempotent<InspectResourceForRunResponse>({
      database: this.database,
      requestId: input.requestId,
      operation: "inspect_resource_for_run",
      payload: input,
    });
    if (replay) return replay;
    this.requireActiveRun(input.runId);
    const observed = await observeResource(input.locator, {
      at: input.at,
      ...(input.kind ? { kind: input.kind } : {}),
    });
    const existingBefore = this.findByObservedLocator(observed.locator);
    const admission: ObservedResourceAdmission = {
      admissionId: input.requestId,
      kind: observed.kind,
      origin: input.origin,
      locator: observed.locator,
      displayName: input.displayName ?? observed.displayName,
      ...(input.description ? { description: input.description } : {}),
      ...(input.aliases ? { aliases: input.aliases } : {}),
      role: "reference",
      version: observed.version,
      ...(observed.mediaType ? { mediaType: observed.mediaType } : {}),
    };
    return executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "inspect_resource_for_run",
      payload: input,
      now: input.at,
      execute: () => {
        const { resource } = upsertResource(this.database, {
          admission,
          runId: input.runId,
          at: input.at,
        });
        recordResourceAccess(this.database, resource.resourceId, input.runId, "opened", input.at);
        invalidateStaleReusableObservations(this.database, input.at);
        return {
          resource,
          existing: Boolean(existingBefore),
          mutationEligible: mutationEligible(resource),
          warnings: observed.warnings,
        };
      },
    });
  }

  find(input: FindResourcesRequest): FindResourcesResponse {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    return {
      resources: findResources(this.database, {
        ...(input.query ? { query: input.query } : {}),
        ...(input.resourceIds ? { resourceIds: input.resourceIds } : {}),
        ...(input.locators ? { locators: input.locators } : {}),
        ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
        includeMissing: input.includeMissing ?? false,
        limit,
      }),
    };
  }

  bind(input: BindResourcesForRunRequest): BindResourcesForRunResponse {
    return executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "bind_resources_for_run",
      payload: input,
      now: input.at,
      execute: () => {
        const run = this.requireBoundRun(input.runId, input.workstreamId);
        return {
          workstreamId: input.workstreamId,
          runId: input.runId,
          bindings: bindResourcesToWorkstream(this.database, {
            runId: input.runId,
            workstreamId: input.workstreamId,
            requestId: run.workstreamBinding!.requestId,
            bindings: input.bindings,
            at: input.at,
          }),
        };
      },
    });
  }

  validateBindings(
    bindings: BindResourcesForRunRequest["bindings"] | undefined,
  ): void {
    if (!bindings || bindings.length === 0) return;
    for (const binding of canonicalizeWorkstreamResourceBindings(bindings)) {
      const resource = readResource(this.database, binding.resourceId);
      if (!resource) {
        throw new ContextEngineServiceError({
          code: "RESOURCE_NOT_FOUND",
          message: "Resource does not exist.",
          details: { resourceId: binding.resourceId },
        });
      }
      if (binding.access === "mutate" && !mutationEligible(resource)) {
        throw new ContextEngineServiceError({
          code: "RESOURCE_MUTATION_UNAVAILABLE",
          message: "This resource cannot receive filesystem mutation authority.",
          details: { resourceId: binding.resourceId },
        });
      }
    }
  }

  async ensureManagedOutput(input: {
    runId: string;
    workstreamId: string;
    title: string;
    at: string;
  }): Promise<WorkstreamResourceBinding[]> {
    const existing = readWorkstreamResourceBindings(this.database, input.workstreamId);
    if (existing.some((binding) => binding.primary)) return existing;
    this.requireBoundRun(input.runId, input.workstreamId);
    await mkdir(this.outputRoot, { recursive: true });
    const outputRoot = await realpath(this.outputRoot);
    const path = join(outputRoot, input.workstreamId + "-" + workstreamSlug(input.title));
    const state = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!state) {
      await mkdir(path);
    } else if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new ContextEngineServiceError({
        code: "RESOURCE_LOCATOR_INVALID",
        message: "Managed workstream output path is not a normal directory.",
        details: { path },
      });
    }
    const canonical = await realpath(path);
    if (dirname(canonical) !== outputRoot) {
      throw new ContextEngineServiceError({
        code: "RESOURCE_LOCATOR_INVALID",
        message: "Managed workstream output directory escaped its configured root.",
        details: { path: canonical },
      });
    }
    const observed = await observeResource({ kind: "filesystem", path: canonical }, {
      at: input.at,
      kind: "directory",
    });
    const admission: ObservedResourceAdmission = {
      admissionId: "managed-output:" + input.runId,
      kind: "directory",
      origin: "agent_created",
      locator: observed.locator,
      displayName: basename(canonical),
      description: "Primary user-visible output directory for " + input.title + ".",
      aliases: [input.title, "primary output", "workspace"],
      role: "reference",
      version: observed.version,
    };
    return this.database.transaction(() => {
      const { resource } = upsertResource(this.database, {
        admission,
        runId: input.runId,
        at: input.at,
      });
      const run = this.requireBoundRun(input.runId, input.workstreamId);
      return bindResourcesToWorkstream(this.database, {
        runId: input.runId,
        workstreamId: input.workstreamId,
        requestId: run.workstreamBinding!.requestId,
        bindings: [{
          resourceId: resource.resourceId,
          role: "primary",
          access: "mutate",
          primary: true,
        }],
        at: input.at,
      });
    });
  }

  async admitCompletionResources(input: {
    runId: string;
    workstreamId: string;
    completion: WorkstreamCompletionRecord;
    at: string;
  }): Promise<WorkstreamResourceBinding[]> {
    const bindings: Array<{
      resourceId: string;
      role: WorkstreamCompletionRecord["resources"][number]["role"];
      access: "read" | "mutate";
    }> = [];
    for (let index = 0; index < input.completion.resources.length; index += 1) {
      const entry = input.completion.resources[index];
      if (!entry) continue;
      let resource = entry.resourceId ? readResource(this.database, entry.resourceId) : undefined;
      if (entry.locator) {
        const observed = await observeResource(entry.locator, {
          at: input.at,
          kind: entry.kind,
        });
        const existingForLocator = readResourceByLocator(this.database, observed.locator);
        const locatorResourceId = existingForLocator?.resourceId
          ?? (observed.locator.kind === "managed_blob"
            ? observed.locator.resourceId
            : resourceIdForLocator(resourceLocatorKey(observed.locator)));
        if (entry.resourceId && entry.resourceId !== locatorResourceId) {
          throw new ContextEngineServiceError({
            code: "RESOURCE_CONFLICT",
            message: "Completion resource identity does not match its locator.",
            details: {
              resourceId: entry.resourceId,
              locatorResourceId,
              index,
            },
          });
        }
        const admission: ObservedResourceAdmission = {
          admissionId: "completion:" + input.runId + ":" + index,
          kind: observed.kind,
          origin: "agent_created",
          locator: observed.locator,
          displayName: observed.displayName,
          description: entry.description,
          aliases: entry.aliases,
          role: "reference",
          version: observed.version,
          ...(observed.mediaType ? { mediaType: observed.mediaType } : {}),
        };
        resource = this.database.transaction(() => upsertResource(this.database, {
          admission,
          runId: input.runId,
          at: input.at,
        }).resource);
      }
      if (!resource || (entry.resourceId && resource.resourceId !== entry.resourceId)) {
        throw new ContextEngineServiceError({
          code: "RESOURCE_NOT_FOUND",
          message: "Completion evidence references an unavailable resource.",
          details: { resourceId: entry.resourceId ?? null, index },
        });
      }
      if (entry.verified
        && (!resource.version.exists
          || resource.availability === "missing"
          || resource.availability === "deleted")) {
        throw new ContextEngineServiceError({
          code: "RESOURCE_VERIFICATION_UNAVAILABLE",
          message: "Verified completion resource is not currently available.",
          details: { resourceId: resource.resourceId },
        });
      }
      bindings.push({
        resourceId: resource.resourceId,
        role: entry.role,
        access: mutationEligible(resource) ? "mutate" : "read",
      });
    }
    if (bindings.length > 0) {
      const run = this.requireBoundRun(input.runId, input.workstreamId);
      this.database.transaction(() => bindResourcesToWorkstream(this.database, {
        runId: input.runId,
        workstreamId: input.workstreamId,
        requestId: run.workstreamBinding!.requestId,
        bindings,
        at: input.at,
      }));
    }
    return readWorkstreamResourceBindings(this.database, input.workstreamId);
  }

  readWorkstreamBindings(workstreamId: string): WorkstreamResourceBinding[] {
    return readWorkstreamResourceBindings(this.database, workstreamId);
  }

  streamProjection(streamId: string): AgentStreamResourcesProjection {
    return readAgentStreamResourcesProjection(this.database, streamId);
  }

  read(resourceId: string): ResourceRef | undefined {
    return readResource(this.database, resourceId);
  }

  private requireActiveRun(runId: string): void {
    const run = readRunEvidence(this.database, runId);
    if (!run || run.status !== "running") {
      throw new ContextEngineServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Resource operation requires the matching active run.",
        details: { runId },
      });
    }
  }

  private requireBoundRun(
    runId: string,
    workstreamId: string,
  ): NonNullable<ReturnType<typeof readRunEvidence>> {
    const run = readRunEvidence(this.database, runId);
    if (!run || run.status !== "running"
      || run.workstreamBinding?.workstreamId !== workstreamId) {
      throw new ContextEngineServiceError({
        code: "RUN_WORKSTREAM_BINDING_REQUIRED",
        message: "Resource binding requires the matching workstream-bound run.",
        details: { runId, workstreamId },
      });
    }
    return run;
  }

  private findByObservedLocator(locator: ResourceRef["locator"]): ResourceRef | undefined {
    const result = this.find({
      locators: [locator.kind === "filesystem"
        ? "filesystem:" + locator.path
        : locator.kind === "url"
          ? "url:" + locator.url
          : locator.kind === "managed_blob"
            ? "managed_blob:" + locator.resourceId
            : "external:" + locator.provider.toLowerCase() + ":" + locator.externalId],
      limit: 1,
    });
    return result.resources[0]?.resource;
  }
}
