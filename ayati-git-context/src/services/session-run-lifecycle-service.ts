import type {
  FinalizeSessionRunRequest,
  FinalizeSessionRunResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  RunContextProjection,
  SessionRef,
  StartRunRequest,
  StartRunResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { executeIdempotent } from "../database/idempotency.js";
import {
  readActiveRun,
  recordRunStep,
  startSessionRun,
} from "../repositories/run-records.js";
import { RunContextHotCache } from "./run-context-hot-cache.js";
import { SessionRunFinalizationService } from "./session-run-finalization-service.js";

export class SessionRunLifecycleService {
  private readonly cache: RunContextHotCache;
  private readonly finalization: SessionRunFinalizationService;

  constructor(private readonly database: ContextDatabase) {
    this.cache = new RunContextHotCache(database);
    this.finalization = new SessionRunFinalizationService(database);
  }

  getActive(sessionId: string): RunContextProjection | undefined {
    const active = readActiveRun(this.database, sessionId);
    return active ? this.cache.get(this.database, active.runId) : undefined;
  }

  start(input: StartRunRequest, at: string): StartRunResponse {
    const normalized = { ...input, at };
    const result = executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "start_run",
      payload: normalized,
      now: at,
      execute: () => ({ run: startSessionRun(this.database, normalized) }),
    });
    this.cache.refresh(this.database, result.run.runId);
    return result;
  }

  recordStep(input: RecordRunStepRequest): RecordRunStepResponse {
    const result = executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "record_run_step",
      payload: input,
      now: input.at,
      execute: () => recordRunStep(this.database, input),
    });
    this.cache.refresh(this.database, input.runId);
    return result;
  }

  async finalize(
    input: FinalizeSessionRunRequest,
    session: SessionRef,
  ): Promise<FinalizeSessionRunResponse> {
    try {
      const result = await this.finalization.finalize(input, session);
      this.cache.remove(input.runId);
      return result;
    } catch (error) {
      try {
        this.cache.refresh(this.database, input.runId);
      } catch {
        this.cache.remove(input.runId);
      }
      throw error;
    }
  }

  refresh(runId: string): void {
    this.cache.refresh(this.database, runId);
  }

  remove(runId: string): void {
    this.cache.remove(runId);
  }

  clear(): void {
    this.cache.clear();
  }
}
