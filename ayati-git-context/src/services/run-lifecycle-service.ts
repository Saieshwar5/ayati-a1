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
import { buildReadContext } from "./read-context-builder.js";
import { RunContextHotCache } from "./run-context-hot-cache.js";

export class RunLifecycleService {
  private readonly cache: RunContextHotCache;

  constructor(private readonly database: ContextDatabase) {
    this.cache = new RunContextHotCache(database);
  }

  getActive(sessionId: string): RunContextProjection | undefined {
    const active = readActiveRun(this.database, sessionId);
    return active ? this.cache.get(this.database, active.runId) : undefined;
  }

  recordStep(input: RecordRunStepRequest): RecordRunStepResponse {
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
          readContext: buildReadContext(this.database, input.sessionId),
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
