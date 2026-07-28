import type {
  ContextEngineRequestEnvelope,
  GetWorkstreamRequest,
  GetWorkstreamResponse,
  WorkstreamCatalogEntry,
  WorkstreamContextProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
} from "../database/idempotency.js";
import { ContextEngineServiceError } from "../errors.js";
import {
  allocateSimpleWorkstream,
  readBindableWorkstreamCatalogEntry,
  readInitializingWorkstreams,
  readWorkstreamInitialization,
} from "../repositories/workstream-records.js";
import { readRecentRequestProgress } from "../repositories/workstream-progress-records.js";
import { readSharedWorkstreamRepositoryState } from "../repositories/workstream-repository-state-records.js";
import {
  readUnfinishedWorkstreamRequests,
  readWorkstreamRequest,
} from "../repositories/workstream-request-records.js";
import { readWorkstreamContext } from "../workstreams/workstream-context-reader.js";
import { projectProvisionalWorkstreamValidation } from "../workstreams/provisional-workstream-context.js";
import { ensureSharedWorkstreamRepository } from "../workstreams/shared-workstream-repository.js";

export interface WorkstreamLifecycleServiceOptions {
  database: ContextDatabase;
  workstreamRoot: string;
  now: () => string;
  onContextRead?: (
    workstream: WorkstreamCatalogEntry,
    context: WorkstreamContextProjection,
  ) => void;
}

export interface CreateSimpleWorkstreamResult {
  workstream: WorkstreamCatalogEntry;
  created: boolean;
}

export interface CreateSimpleWorkstreamInput extends ContextEngineRequestEnvelope {
  runId: string;
  title: string;
  objective: string;
  initialRequest?: {
    title: string;
    request: string;
    acceptance: string[];
    constraints: string[];
  };
  at: string;
}

export class WorkstreamLifecycleService {
  constructor(private readonly options: WorkstreamLifecycleServiceOptions) {}

  async ensureRepository(at = this.options.now()): Promise<void> {
    await ensureSharedWorkstreamRepository({
      database: this.options.database,
      workstreamRoot: this.options.workstreamRoot,
      at,
    });
  }

  async createSimpleWorkstream(
    input: CreateSimpleWorkstreamInput,
  ): Promise<CreateSimpleWorkstreamResult> {
    const normalized = normalizeWorkstreamInput(input);
    validateSimpleWorkstreamCreationInput(input);
    await this.ensureRepository(input.at);
    type Allocation = { workstreamId: string; created: true } | CreateSimpleWorkstreamResult;
    const pending = beginRecoverableIdempotent<Allocation>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "create_simple_workstream",
      payload: input,
      now: input.at,
      execute: () => {
        const record = allocateSimpleWorkstream(
          this.options.database,
          this.options.workstreamRoot,
          {
            ...input,
            ...(normalized.initialRequest
              ? { initialRequest: normalized.initialRequest }
              : {}),
          },
          normalized,
        );
        return { workstreamId: record.workstreamId, created: true };
      },
    });
    if (pending.completed && "workstream" in pending.result) return pending.result;
    const workstreamId = "workstreamId" in pending.result
      ? pending.result.workstreamId
      : pending.result.workstream.workstreamId;
    const record = readWorkstreamInitialization(this.options.database, workstreamId);
    const workstream = readBindableWorkstreamCatalogEntry(
      this.options.database,
      workstreamId,
    );
    if (!record || !workstream) throw workstreamNotFound(workstreamId);
    const result: CreateSimpleWorkstreamResult = {
      workstream,
      created: pending.result.created,
    };
    return completeRecoverableIdempotent({
      database: this.options.database,
      requestId: input.requestId,
      result,
      now: input.at,
    });
  }

  async getWorkstream(input: GetWorkstreamRequest): Promise<GetWorkstreamResponse> {
    validateWorkstreamId(input.workstreamId);
    const workstream = this.requireReadableWorkstream(input.workstreamId);
    const context = await this.readContext(workstream);
    return {
      workstream: {
        ...workstream,
        contextRepositoryPath: context.workstream.contextRepositoryPath,
        branch: context.workstream.branch,
        head: context.workstream.head,
        title: context.title,
        objective: context.objective,
      },
      context: {
        ...context,
        unfinishedRequests: readUnfinishedWorkstreamRequests(
          this.options.database,
          workstream.workstreamId,
        ).map((request) => ({
          id: request.id,
          title: request.title,
          status: request.status as "queued" | "active" | "blocked",
          request: request.request,
          acceptance: [...request.acceptance],
          constraints: [...request.constraints],
        })),
      },
    };
  }

  async getWorkstreamRequestContext(input: {
    workstreamId: string;
    requestId: string;
  }): Promise<GetWorkstreamResponse> {
    const result = await this.getWorkstream({ workstreamId: input.workstreamId });
    const request = readWorkstreamRequest(
      this.options.database,
      input.workstreamId,
      input.requestId,
    );
    if (!request || !result.context) {
      throw new ContextEngineServiceError({
        code: "NOT_FOUND",
        message: "Workstream request does not exist.",
        details: {
          workstreamId: input.workstreamId,
          requestId: input.requestId,
        },
      });
    }
    const recentProgress = readRecentRequestProgress(this.options.database, {
      workstreamId: input.workstreamId,
      requestId: input.requestId,
      limit: 5,
    }).map((entry) => ({
      runId: entry.runId,
      outcome: entry.outcome,
      summary: entry.summary,
      validationSummary: entry.validationSummary,
      ...(entry.nextAction ? { nextAction: entry.nextAction } : {}),
      commit: entry.commit,
      finalizedAt: entry.finalizedAt,
    }));
    return {
      ...result,
      context: {
        ...result.context,
        selectedRequest: {
          id: request.id,
          title: request.title,
          status: request.status,
          request: request.request,
          acceptance: [...request.acceptance],
          constraints: [...request.constraints],
          lifecycleNote: request.lifecycleNote,
          finalOutcome: request.finalOutcome,
        },
        recentProgress,
      },
    };
  }

  async recoverInitializingState(): Promise<void> {
    await this.ensureRepository();
    for (const workstream of readInitializingWorkstreams(this.options.database)) {
      const boundRun = this.options.database.prepare([
        "SELECT run_id FROM runs WHERE workstream_id = ? LIMIT 1",
      ].join(" ")).get(workstream.workstreamId) as { run_id: string } | undefined;
      if (boundRun) {
        // A bound provisional workstream belongs to run finalization recovery,
        // which materializes its first progress entry and commit.
        continue;
      }
      this.options.database.prepare([
        "DELETE FROM workstreams WHERE workstream_id = ?",
        "AND status = 'initializing' AND last_commit_sha IS NULL",
      ].join(" ")).run(workstream.workstreamId);
    }
  }

  async readContext(
    workstream: WorkstreamCatalogEntry,
  ): Promise<WorkstreamContextProjection> {
    const record = readWorkstreamInitialization(
      this.options.database,
      workstream.workstreamId,
    );
    if (!record) throw workstreamNotFound(workstream.workstreamId);
    const context = record.materialized
      ? await readWorkstreamContext(workstream, {
          workstreamRoot: this.options.workstreamRoot,
        })
      : this.readProvisionalContext(record);
    if (record.materialized) this.options.onContextRead?.(workstream, context);
    return context;
  }

  private readProvisionalContext(
    record: NonNullable<ReturnType<typeof readWorkstreamInitialization>>,
  ): WorkstreamContextProjection {
    const repository = readSharedWorkstreamRepositoryState(this.options.database);
    if (!repository) throw new Error("Shared workstream repository is unavailable.");
    const validation = projectProvisionalWorkstreamValidation({
      database: this.options.database,
      workstream: record,
      repository,
    });
    const request = validation.currentRequest;
    return {
      workstream: {
        workstreamId: record.workstreamId,
        contextRepositoryPath: record.contextRepositoryPath,
        branch: repository.branch,
        head: record.head,
      },
      title: validation.workstreamCard.title,
      objective: validation.workstreamCard.purpose,
      summary: validation.workstreamCard.currentSnapshot,
      recentCommits: [],
      schemaVersion: validation.workstreamCard.schema,
      lifecycleStatus: validation.workstreamCard.status,
      repositoryHealth: validation.health,
      currentFocus: validation.workstreamCard.currentFocus,
      blockers: [...validation.workstreamCard.blockers],
      ...(request ? {
        currentRequest: {
          id: request.id,
          title: request.title,
          status: request.status,
          request: request.request,
          acceptance: [...request.acceptance],
          constraints: [...request.constraints],
        },
      } : {}),
    };
  }

  private requireReadableWorkstream(workstreamId: string): WorkstreamCatalogEntry {
    const workstream = readBindableWorkstreamCatalogEntry(
      this.options.database,
      workstreamId,
    );
    if (!workstream) throw workstreamNotFound(workstreamId);
    return workstream;
  }
}

function normalizeWorkstreamInput(input: CreateSimpleWorkstreamInput): {
  title: string;
  objective: string;
  initialRequest?: NonNullable<CreateSimpleWorkstreamInput["initialRequest"]>;
} {
  const title = normalizeBounded(input.title, "Workstream title", 120);
  const objective = normalizeBounded(input.objective, "Workstream objective", 2_000);
  const initialRequest = input.initialRequest
    ? {
        title: normalizeBounded(input.initialRequest.title, "Initial request title", 120),
        request: normalizeBounded(input.initialRequest.request, "Initial request", 4_000),
        acceptance: normalizeList(
          input.initialRequest.acceptance,
          "Initial request acceptance",
          500,
          false,
        ),
        constraints: normalizeList(
          input.initialRequest.constraints,
          "Initial request constraints",
          500,
          true,
        ),
      }
    : undefined;
  return { title, objective, ...(initialRequest ? { initialRequest } : {}) };
}

function normalizeBounded(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    throw invalid(`${field} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function normalizeList(
  values: string[],
  field: string,
  maximum: number,
  allowEmpty: boolean,
): string[] {
  const result = [...new Set(values.map((value) => normalizeBounded(value, field, maximum)))];
  if ((!allowEmpty && result.length === 0) || result.length > 20) {
    throw invalid(`${field} must contain ${allowEmpty ? "0" : "1"} to 20 entries.`);
  }
  return result;
}

function validateSimpleWorkstreamCreationInput(input: CreateSimpleWorkstreamInput): void {
  if (!input.runId || !input.requestId || !Number.isFinite(Date.parse(input.at))) {
    throw invalid("Workstream creation requires a run, request, and valid timestamp.");
  }
}

function validateWorkstreamId(workstreamId: string): void {
  if (!/^W-\d{8}-\d{4}$/.test(workstreamId)) throw workstreamNotFound(workstreamId);
}

function workstreamNotFound(workstreamId: string): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_NOT_FOUND",
    message: "Workstream does not exist or is not available.",
    details: { workstreamId },
  });
}

function invalid(message: string): ContextEngineServiceError {
  return new ContextEngineServiceError({ code: "INVALID_REQUEST", message });
}
