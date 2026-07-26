import type {
  CheckpointRunWorkStateRequest,
  CheckpointRunWorkStateResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  RunContextProjection,
} from "../contracts.js";
import { ContextEngineServiceError } from "../errors.js";
import type { ContextDatabase } from "../database/database.js";
import { executeIdempotent } from "../database/idempotency.js";
import {
  readActiveRun,
  readRunEvidence,
  recordRunStep,
} from "../repositories/run-records.js";
import {
  readRunWorkState,
  replaceRunWorkState,
} from "../repositories/run-work-state-records.js";
import { RunContextHotCache } from "./run-context-hot-cache.js";

export class RunLifecycleService {
  private readonly cache: RunContextHotCache;

  constructor(private readonly database: ContextDatabase) {
    this.cache = new RunContextHotCache(database);
  }

  getActive(streamId: string): RunContextProjection | undefined {
    const active = readActiveRun(this.database, streamId);
    return active ? this.cache.get(this.database, active.runId) : undefined;
  }

  recordStep(input: RecordRunStepRequest): Pick<RecordRunStepResponse, "run"> {
    const result = executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "record_run_step",
      payload: input,
      now: input.record.createdAt,
      execute: () => {
        recordRunStep(this.database, input);
        return {
          run: this.cache.refresh(this.database, input.runId),
        };
      },
    });
    this.cache.refresh(this.database, input.runId);
    return result;
  }

  checkpointWorkState(
    input: CheckpointRunWorkStateRequest,
  ): Pick<CheckpointRunWorkStateResponse, "run"> {
    const result = executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "checkpoint_run_work_state",
      payload: input,
      now: input.at,
      execute: () => {
        const run = readRunEvidence(this.database, input.runId);
        if (!run || run.status !== "running") {
          throw new ContextEngineServiceError({
            code: "RUN_NOT_ACTIVE",
            message: "WorkState checkpoints require an active run.",
            details: { runId: input.runId },
          });
        }
        if (run.stepCount !== input.afterStep) {
          throw new ContextEngineServiceError({
            code: "RUN_STEP_NOT_CONTIGUOUS",
            message: "WorkState checkpoint must cover the current persisted step.",
            details: {
              runId: input.runId,
              expectedStep: run.stepCount,
              receivedStep: input.afterStep,
            },
          });
        }
        const current = readRunWorkState(this.database, input.runId);
        if (!current) {
          throw new Error("Run WorkState is missing: " + input.runId);
        }
        replaceRunWorkState(this.database, {
          runId: input.runId,
          afterStep: input.afterStep,
          state: input.workState,
          reason: input.reason,
          at: input.at,
          expectedRevision: input.expectedRevision,
        });
        return {
          run: this.cache.refresh(this.database, input.runId),
        };
      },
    });
    this.cache.refresh(this.database, input.runId);
    return result;
  }

  refresh(runId: string): RunContextProjection {
    return this.cache.refresh(this.database, runId);
  }

  remove(runId: string): void {
    this.cache.remove(runId);
  }

  clear(): void {
    this.cache.clear();
  }
}
