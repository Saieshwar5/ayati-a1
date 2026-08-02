import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FinalizeRunRequest,
  RunWorkState,
  WorkstreamCompletionRecord,
  WorkstreamRequestLifecycleEffect,
  WorkstreamResourceBinding,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import { contentHash } from "../git/workstream-context-transaction.js";
import { readResourceEventsForRun } from "../repositories/resource-records.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { readRunWorkState } from "../repositories/run-work-state-records.js";
import type { WorkstreamContextCommitPlan } from "../repositories/workstream-finalization-records.js";
import { readWorkstreamInitialization } from "../repositories/workstream-records.js";
import { readSharedWorkstreamRepositoryState } from "../repositories/workstream-repository-state-records.js";
import { readWorkstreamRequestRoutePlan } from "../repositories/workstream-request-route-plan-records.js";
import { buildInitialWorkstreamContext } from "../workstreams/initial-workstream-context.js";
import { resolvePlannedWorkstreamRequestState } from "../workstreams/planned-workstream-request.js";
import { projectProvisionalWorkstreamValidation } from "../workstreams/provisional-workstream-context.js";
import { appendWorkstreamProgressEntry } from "../workstreams/workstream-progress.js";
import { buildWorkstreamProgressEntry } from "../workstreams/workstream-progress-projection.js";
import { reduceSimpleWorkstreamContext } from "../workstreams/simple-workstream-context-reducer.js";
import {
  WORKSTREAM_PROGRESS_PATH,
  WORKSTREAM_RESOURCES_PATH,
} from "../workstreams/workstream-repository-layout.js";
import {
  renderWorkstreamResourceManifest,
  WORKSTREAM_RESOURCE_MANIFEST_SCHEMA,
} from "../workstreams/workstream-resource-manifest.js";
import {
  validateWorkstreamRepository,
} from "../workstreams/workstream-repository-validator.js";
import type { ResourceCatalogService } from "./resource-catalog-service.js";

export interface BoundWorkstreamFinalizeInput extends Omit<FinalizeRunRequest, "workstream"> {
  workstreamId: string;
  boundRequestId: string;
  completion: WorkstreamCompletionRecord;
  requestEffect: WorkstreamRequestLifecycleEffect;
}

export async function prepareWorkstreamFinalization(input: {
  database: ContextDatabase;
  workstreamRoot: string;
  resourceCatalog: ResourceCatalogService;
  request: BoundWorkstreamFinalizeInput;
}): Promise<{
  run: NonNullable<ReturnType<typeof readRunEvidence>>;
  baseHead: string;
  workstreamBaseHead: string;
  resourceEvents: ReturnType<typeof readResourceEventsForRun>;
  plan: WorkstreamContextCommitPlan;
  finalSummary: string;
  commitContext: {
    workstreamTitle: string;
    requestTitle: string;
    requestStatusAfter: "queued" | "active" | "blocked" | "done" | "dropped";
    criteriaPassed: number;
    criteriaTotal: number;
  };
}> {
  const request = input.request;
  const run = readRunEvidence(input.database, request.runId);
  if (!run || run.status !== "running"
    || run.workstreamBinding?.workstreamId !== request.workstreamId
    || run.workstreamBinding.requestId !== request.boundRequestId) {
    throw invalid("Finalization requires the matching active workstream-bound run.");
  }
  requireVerifiedMutationState(input.database, request.runId);
  const workstream = readWorkstreamInitialization(input.database, request.workstreamId);
  if (!workstream?.head
    || (workstream.status !== "active" && workstream.status !== "initializing")) {
    throw invalid("Finalization requires an active workstream context repository.");
  }
  const repository = readSharedWorkstreamRepositoryState(input.database);
  if (!repository) throw recovery("Shared workstream repository state is unavailable.");
  const validation = workstream.materialized
    ? await validateWorkstreamRepository({
        workstreamRoot: input.workstreamRoot,
        contextRepositoryPath: workstream.contextRepositoryPath,
        expectedWorkstreamId: request.workstreamId,
        requestReadMode: "all",
      })
    : projectProvisionalWorkstreamValidation({
        database: input.database,
        workstream,
        repository,
      });
  if (validation.head !== workstream.head || validation.branch !== workstream.branch) {
    throw headMismatch(request.workstreamId, workstream.head, validation.head);
  }
  if (validation.repositoryHead !== repository.head) {
    throw recovery("Shared repository HEAD differs from its SQLite coordination state.", {
      sqliteHead: repository.head,
      actualHead: validation.repositoryHead,
    });
  }
  if (validation.health !== "ready") {
    throw recovery("Workstream context repository has unjournaled changes.", {
      workingTreeChanges: validation.workingTreeChanges,
    });
  }
  const routePlan = readWorkstreamRequestRoutePlan(input.database, request.runId);
  if (routePlan?.phase !== undefined && routePlan.phase !== "planned") {
    throw recovery("Workstream request route plan is not active.", {
      phase: routePlan.phase,
    });
  }
  const planned = routePlan
    ? resolvePlannedWorkstreamRequestState(routePlan, validation)
    : validation.currentRequest
      ? {
          workstreamCard: validation.workstreamCard,
          workstreamRequest: validation.currentRequest,
          requestCreated: false,
        }
      : undefined;
  if (!planned || planned.workstreamRequest.id !== request.boundRequestId) {
    throw recovery("Finalization request no longer matches the run binding.");
  }

  await input.resourceCatalog.applyVerifiedFilesystemEffects({
    runId: request.runId,
    workstreamId: request.workstreamId,
    requestId: request.boundRequestId,
    effects: request.completion.effects ?? [],
    at: request.at,
  });
  const bindings = await input.resourceCatalog.admitCompletionResources({
    runId: request.runId,
    workstreamId: request.workstreamId,
    completion: request.completion,
    at: request.at,
  });
  const resourceEvents = readResourceEventsForRun(input.database, request.runId);
  const currentWorkState = readRunWorkState(input.database, request.runId);
  if (!currentWorkState) throw recovery("Finalization requires persisted WorkState.");
  const finalWorkState: RunWorkState = {
    ...request.workState,
    runId: request.runId,
    revision: currentWorkState.revision + 1,
    afterStep: run.stepCount,
    updateReason: request.outcome === "done" ? "run_completed" : "run_paused",
    updatedAt: request.at,
  };
  const reduced = reduceSimpleWorkstreamContext({
    expectedHead: workstream.head,
    workstreamCard: planned.workstreamCard,
    workstreamRequest: planned.workstreamRequest,
    workState: finalWorkState,
    outcome: request.outcome,
    validation: request.validation,
    summary: request.summary,
    ...(request.next ? { next: request.next } : {}),
    completion: request.completion,
    requestEffect: request.requestEffect,
    hasVerifiedChanges: resourceEvents.length > 0,
    at: request.at,
  });
  const progressContent = appendWorkstreamProgressEntry(
    validation.progress.content,
    buildWorkstreamProgressEntry({
      runId: request.runId,
      requestId: request.boundRequestId,
      at: request.at,
      outcome: request.outcome,
      summary: request.summary,
      validation: request.validation,
      workState: finalWorkState,
      completion: request.completion,
      resourceEvents,
      ...(request.next ? { next: request.next } : {}),
    }),
  );
  const desiredWrites = workstream.materialized
    ? new Map<string, string>()
    : buildInitialWorkstreamContext({
        workstreamId: workstream.workstreamId,
        title: workstream.title,
        purpose: workstream.objective,
        at: workstream.createdAt,
        ...(workstream.initialRequest
          ? { initialRequest: workstream.initialRequest }
          : {}),
      }).files;
  if (routePlan?.changePlan) {
    for (const write of routePlan.changePlan.writes) {
      desiredWrites.set(write.path, write.content);
    }
  }
  for (const write of reduced.contextWrites) {
    desiredWrites.set(write.path, write.content);
  }
  desiredWrites.set(WORKSTREAM_PROGRESS_PATH, progressContent);
  desiredWrites.set(WORKSTREAM_RESOURCES_PATH, renderResourceManifest(
    request.workstreamId,
    validation.resourceManifest.updatedAt,
    bindings,
  ));
  const contextWrites = await changedWrites(
    workstream.contextRepositoryPath,
    desiredWrites,
  );
  const contextBefore = await Promise.all(contextWrites.map(async (write) => ({
    path: write.path,
    sha256: await readContextHash(workstream.contextRepositoryPath, write.path),
  })));
  return {
    run,
    baseHead: repository.head,
    workstreamBaseHead: workstream.head,
    resourceEvents,
    plan: {
      commitRequired: true,
      contextWrites,
      contextBefore,
      stagedPaths: contextWrites.map((write) => write.path).sort(),
      commitMessage: "",
    },
    finalSummary: reduced.contextWrites.length > 0
      ? reduced.workstreamCard.currentSnapshot
      : normalizeText(request.summary),
    commitContext: {
      workstreamTitle: reduced.workstreamCard.title,
      requestTitle: reduced.workstreamRequest.title,
      requestStatusAfter: reduced.workstreamRequest.status,
      criteriaPassed: request.completion.criteria.filter((criterion) => criterion.passed).length,
      criteriaTotal: request.completion.criteria.length,
    },
  };
}

function requireVerifiedMutationState(database: ContextDatabase, runId: string): void {
  const blocking = database.prepare([
    "SELECT o.operation_id, o.status, l.status AS lease_status",
    "FROM resource_mutation_operations o JOIN resource_mutation_leases l ON l.lease_id = o.lease_id",
    "WHERE o.run_id = ? AND (o.status IN ('prepared', 'recovery_required')",
    "OR l.status IN ('active', 'recovery_required')) LIMIT 1",
  ].join(" ")).get(runId) as {
    operation_id: string;
    status: string;
    lease_status: string;
  } | undefined;
  if (blocking) {
    throw recovery("Run has an unverified or recovery-required resource mutation.", {
      operationId: blocking.operation_id,
      operationStatus: blocking.status,
      leaseStatus: blocking.lease_status,
    });
  }
}

function renderResourceManifest(
  workstreamId: string,
  existingUpdatedAt: string,
  bindings: WorkstreamResourceBinding[],
): string {
  const updatedAt = bindings.reduce(
    (latest, binding) => binding.lastUsedAt && binding.lastUsedAt > latest
      ? binding.lastUsedAt
      : latest,
    existingUpdatedAt,
  );
  return renderWorkstreamResourceManifest({
    schema: WORKSTREAM_RESOURCE_MANIFEST_SCHEMA,
    workstreamId,
    updatedAt,
    resources: bindings.map((binding) => ({
      resourceId: binding.resource.resourceId,
      kind: binding.resource.kind,
      origin: binding.resource.origin,
      role: binding.role,
      access: binding.access,
      primary: binding.primary,
      requestIds: binding.requestIds,
      displayName: binding.resource.displayName,
      description: binding.resource.description,
      aliases: binding.resource.aliases,
      locator: binding.resource.locator,
      ...(binding.resource.formerLocators
        ? { formerLocators: binding.resource.formerLocators }
        : {}),
      version: binding.resource.version,
      availability: binding.resource.availability,
      metadataStatus: binding.resource.metadataStatus,
      ...(binding.resource.describedVersionKey
        ? { describedVersionKey: binding.resource.describedVersionKey }
        : {}),
      ...(binding.resource.mediaType ? { mediaType: binding.resource.mediaType } : {}),
      ...(binding.lastUsedAt ? { lastUsedAt: binding.lastUsedAt } : {}),
    })),
  });
}

async function changedWrites(
  contextRepositoryPath: string,
  desired: ReadonlyMap<string, string>,
): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  for (const [path, content] of desired) {
    const current = await readFile(join(contextRepositoryPath, path), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (current !== content) result.push({ path, content });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function readContextHash(contextRepositoryPath: string, path: string): Promise<string> {
  try {
    return contentHash(await readFile(join(contextRepositoryPath, path), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function invalid(message: string): ContextEngineServiceError {
  return new ContextEngineServiceError({ code: "INVALID_REQUEST", message });
}

function recovery(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "RECOVERY_REQUIRED",
    message,
    ...(details ? { details } : {}),
  });
}

function headMismatch(
  workstreamId: string,
  expected: string,
  actual: string,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_HEAD_MISMATCH",
    message: "Workstream context HEAD changed during finalization.",
    details: { workstreamId, expectedHead: expected, actualHead: actual },
  });
}
