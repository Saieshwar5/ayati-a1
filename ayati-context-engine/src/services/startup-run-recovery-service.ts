import type { ContextDatabase } from "../database/database.js";
import {
  finalizeRunRecord,
  markRunRecoveryRequired,
  readActiveRunIds,
  readRunEvidence,
} from "../repositories/run-records.js";
import { readWorkstreamFinalization } from "../repositories/workstream-finalization-records.js";
import {
  readWorkstreamRequestRoutePlan,
  updateWorkstreamRequestRoutePlan,
} from "../repositories/workstream-request-route-plan-records.js";
import { readUnboundRunFinalization } from "../repositories/unbound-run-finalization-records.js";

export interface StartupRunRecoveryResult {
  interruptedRunIds: string[];
  recoveryRequiredRunIds: string[];
}

/** Resolves runs left open outside either durable finalization journal. */
export class StartupRunRecoveryService {
  constructor(private readonly database: ContextDatabase) {}

  recover(at: string): StartupRunRecoveryResult {
    const result: StartupRunRecoveryResult = {
      interruptedRunIds: [],
      recoveryRequiredRunIds: [],
    };
    for (const runId of readActiveRunIds(this.database)) {
      const run = readRunEvidence(this.database, runId);
      if (!run || (run.status !== "running" && run.status !== "recovery_required")) continue;

      const hasFinalizationJournal = Boolean(
        readUnboundRunFinalization(this.database, runId)
        || readWorkstreamFinalization(this.database, runId),
      );
      const mutation = this.database.prepare([
        "SELECT status FROM resource_mutation_leases",
        "WHERE run_id = ? AND status IN ('active', 'recovery_required') LIMIT 1",
      ].join(" ")).get(runId) as { status: string } | undefined;
      const routePlan = readWorkstreamRequestRoutePlan(this.database, runId);
      if (run.status === "recovery_required"
        || hasFinalizationJournal
        || Boolean(mutation)
        || routePlan?.phase === "recovery_required") {
        markRunRecoveryRequired(this.database, runId);
        result.recoveryRequiredRunIds.push(runId);
        continue;
      }

      try {
        this.database.transaction(() => {
          if (routePlan?.phase === "planned") {
            updateWorkstreamRequestRoutePlan(this.database, {
              runId,
              phase: "discarded",
              at,
            });
          }
          finalizeRunRecord(this.database, {
            runId,
            outcome: "incomplete",
            stopReason: "interrupted",
            at,
          });
        });
        result.interruptedRunIds.push(runId);
      } catch {
        markRunRecoveryRequired(this.database, runId);
        result.recoveryRequiredRunIds.push(runId);
      }
    }
    return result;
  }
}
