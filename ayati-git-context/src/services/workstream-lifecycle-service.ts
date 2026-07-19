import type {
  GetWorkstreamRequest,
  GetWorkstreamResponse,
  GitContextRequestEnvelope,
  WorkstreamCatalogEntry,
  WorkstreamContextProjection,
  SessionId,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  hasRecoverableIdempotencyRequest,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  activateWorkstream,
  allocateSimpleWorkstream,
  readInitializingWorkstreams,
  readWorkstreamCatalogEntry,
  readWorkstreamInitialization,
  type WorkstreamInitializationRecord,
} from "../repositories/workstream-records.js";
import { readWorkstreamContext } from "../workstreams/workstream-context-reader.js";
import {
  completeSimpleWorkstreamCreation,
  ensureSimpleWorkstreamRepository,
  type SimpleWorkstreamCreationHook,
} from "../workstreams/simple-workstream-repository-creator.js";

export interface WorkstreamLifecycleServiceOptions {
  database: ContextDatabase;
  workstreamRoot: string;
  now: () => string;
  simpleWorkstreamCreationHook?: SimpleWorkstreamCreationHook;
  onContextRead?: (workstream: WorkstreamCatalogEntry, context: WorkstreamContextProjection) => void;
}

export interface CreateSimpleWorkstreamResult {
  workstream: WorkstreamCatalogEntry;
  created: boolean;
}

export interface CreateSimpleWorkstreamInput extends GitContextRequestEnvelope {
  sessionId: SessionId;
  runId?: string;
  title: string;
  objective: string;
  at: string;
}

export class WorkstreamLifecycleService {
  private readonly database: ContextDatabase;
  private readonly workstreamRoot: string;
  private readonly now: () => string;
  private readonly simpleWorkstreamCreationHook?: SimpleWorkstreamCreationHook;
  private readonly onContextRead?: (
    workstream: WorkstreamCatalogEntry,
    context: WorkstreamContextProjection,
  ) => void;

  constructor(options: WorkstreamLifecycleServiceOptions) {
    this.database = options.database;
    this.workstreamRoot = options.workstreamRoot;
    this.now = options.now;
    this.simpleWorkstreamCreationHook = options.simpleWorkstreamCreationHook;
    this.onContextRead = options.onContextRead;
  }

  async createSimpleWorkstream(input: CreateSimpleWorkstreamInput): Promise<CreateSimpleWorkstreamResult> {
    const normalized = normalizeWorkstreamInput(input);
    validateSimpleWorkstreamCreationInput(input);
    const recovering = hasRecoverableIdempotencyRequest({
      database: this.database,
      requestId: input.requestId,
      operation: "create_simple_workstream",
      payload: input,
    });
    type CreationRecord = { workstreamId: string; created: boolean } | CreateSimpleWorkstreamResult;
    const pending = beginRecoverableIdempotent<CreationRecord>({
      database: this.database,
      requestId: input.requestId,
      operation: "create_simple_workstream",
      payload: input,
      now: input.at,
      execute: () => {
        const workstream = allocateSimpleWorkstream(
          this.database,
          this.workstreamRoot,
          input,
          normalized,
        );
        return { workstreamId: workstream.workstreamId, created: true };
      },
    });
    const workstreamId = "workstreamId" in pending.result
      ? pending.result.workstreamId
      : pending.result.workstream.workstreamId;
    if (pending.completed && "workstream" in pending.result) return pending.result;
    try {
      const record = readWorkstreamInitialization(this.database, workstreamId);
      if (!record) throw workstreamNotFound(workstreamId);
      await this.simpleWorkstreamCreationHook?.("allocated", record);
      const workstream = await this.initializeSimpleWorkstream(record, input.at, recovering);
      const result: CreateSimpleWorkstreamResult = { workstream, created: pending.result.created };
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result,
        now: input.at,
      });
    } catch (error) {
      markRecoverableIdempotencyFailed({
        database: this.database,
        requestId: input.requestId,
      });
      throw error;
    }
  }

  async getWorkstream(input: GetWorkstreamRequest): Promise<GetWorkstreamResponse> {
    validateWorkstreamId(input.workstreamId);
    const workstream = this.requireActiveWorkstream(input.workstreamId);
    const record = readWorkstreamInitialization(this.database, input.workstreamId);
    if (!record) {
      throw workstreamNotFound(input.workstreamId);
    }
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
      context,
    };
  }

  async recoverInitializingState(): Promise<void> {
    for (const workstream of readInitializingWorkstreams(this.database)) {
      try {
        const head = await ensureSimpleWorkstreamRepository({
          workstream,
          workstreamRoot: this.workstreamRoot,
          recovering: true,
        });
        activateWorkstream(this.database, workstream.workstreamId, head, this.now());
        await completeSimpleWorkstreamCreation(workstream);
      } catch {
        // One ambiguous context repository must not prevent unrelated sessions
        // and workstreams from recovering. The original request can retry the
        // same idempotent initialization record.
      }
    }
  }

  private async initializeSimpleWorkstream(
    record: WorkstreamInitializationRecord,
    at: string,
    recovering: boolean,
  ): Promise<WorkstreamCatalogEntry> {
    if (record.status !== "initializing") {
      await completeSimpleWorkstreamCreation(record);
      const workstream = this.requireActiveWorkstream(record.workstreamId);
      const context = await this.readContext(workstream);
      if (context.workstream.head !== workstream.head) {
        throw new GitContextServiceError({
          code: "WORKSTREAM_HEAD_MISMATCH",
          message: "Recovered workstream HEAD does not match its catalog entry.",
          details: { workstreamId: workstream.workstreamId, catalogHead: workstream.head, actualHead: context.workstream.head },
        });
      }
      return workstream;
    }
    const head = await ensureSimpleWorkstreamRepository({
      workstream: record,
      workstreamRoot: this.workstreamRoot,
      recovering,
      ...(this.simpleWorkstreamCreationHook ? { onPhase: this.simpleWorkstreamCreationHook } : {}),
    });
    const workstream = activateWorkstream(this.database, record.workstreamId, head, at);
    await this.simpleWorkstreamCreationHook?.("catalog_activated", record);
    await completeSimpleWorkstreamCreation(record);
    return workstream;
  }

  private requireActiveWorkstream(workstreamId: string): WorkstreamCatalogEntry {
    const workstream = readWorkstreamCatalogEntry(this.database, workstreamId);
    if (!workstream || workstream.status !== "active") {
      throw workstreamNotFound(workstreamId);
    }
    return workstream;
  }

  async readContext(
    workstream: WorkstreamCatalogEntry,
  ): Promise<WorkstreamContextProjection> {
    const context = await readWorkstreamContext(workstream, {
      workstreamRoot: this.workstreamRoot,
    });
    this.onContextRead?.(workstream, context);
    return context;
  }
}

function normalizeWorkstreamInput(input: CreateSimpleWorkstreamInput): {
  title: string;
  objective: string;
} {
  const title = input.title.trim().replace(/\s+/g, " ");
  const objective = input.objective.trim().replace(/\s+/g, " ");
  if (title.length === 0 || title.length > 120) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Workstream title must contain between 1 and 120 characters.",
    });
  }
  if (objective.length === 0 || objective.length > 2_000) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Workstream objective must contain between 1 and 2000 characters.",
    });
  }
  return { title, objective };
}

function validateWorkstreamId(workstreamId: string): void {
  if (!/^W-\d{8}-\d{4}$/.test(workstreamId)) {
    throw workstreamNotFound(workstreamId);
  }
}

function validateSimpleWorkstreamCreationInput(input: CreateSimpleWorkstreamInput): void {
  if (!Number.isFinite(Date.parse(input.at))) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Workstream creation time must be a valid timestamp.",
    });
  }
}

function workstreamNotFound(workstreamId: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "WORKSTREAM_NOT_FOUND",
    message: "Workstream does not exist.",
    details: { workstreamId },
  });
}
