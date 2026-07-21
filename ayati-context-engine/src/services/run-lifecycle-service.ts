import type {
  RecordRunStepRequest,
  RecordRunStepResponse,
  RunContextProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { executeIdempotent } from "../database/idempotency.js";
import {
  readActiveRun,
  recordRunStep,
} from "../repositories/run-records.js";
import { RunContextHotCache } from "./run-context-hot-cache.js";

export class RunLifecycleService {
  private readonly cache: RunContextHotCache;

  constructor(
    private readonly database: ContextDatabase,
    private readonly onStepRecorded?: (input: RecordRunStepRequest) => void,
  ) {
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
        this.onStepRecorded?.(input);
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
