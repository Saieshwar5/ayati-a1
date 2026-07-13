import type { RunContextProjection } from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  readActiveRunIds,
  readRunEvidence,
  readRunStepEvidence,
} from "../repositories/run-records.js";
import { readRunWorkState } from "../repositories/run-work-state-records.js";

export class RunContextHotCache {
  private readonly byRunId = new Map<string, RunContextProjection>();

  constructor(database: ContextDatabase) {
    for (const runId of readActiveRunIds(database)) {
      this.refresh(database, runId);
    }
  }

  get(database: ContextDatabase, runId: string): RunContextProjection {
    return this.byRunId.get(runId) ?? this.refresh(database, runId);
  }

  refresh(database: ContextDatabase, runId: string): RunContextProjection {
    const run = readRunEvidence(database, runId);
    const workState = readRunWorkState(database, runId);
    if (!run || !workState) {
      throw new Error("Active run context is incomplete: " + runId);
    }
    const context: RunContextProjection = {
      run,
      workState,
      steps: readRunStepEvidence(database, runId),
    };
    this.byRunId.set(runId, context);
    return context;
  }

  remove(runId: string): void {
    this.byRunId.delete(runId);
  }

  clear(): void {
    this.byRunId.clear();
  }
}
