import type { ContextDatabase } from "../database/database.js";
import { closeRunConversationWithoutAssistant } from "../repositories/conversation-records.js";
import {
  readMutationAuthorityForRun,
  type MutationAuthorityRecord,
} from "../repositories/mutation-authority-records.js";
import {
  finalizeRunRecord,
  markRunRecoveryRequired,
  readActiveRunIds,
  readRunEvidence,
} from "../repositories/run-records.js";
import { readSimpleTaskFinalization } from "../repositories/simple-task-finalization-records.js";
import {
  readTaskRequestRoutePlan,
  updateTaskRequestRoutePlan,
} from "../repositories/task-request-route-plan-records.js";
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
        || readSimpleTaskFinalization(this.database, runId),
      );
      const authority = readMutationAuthorityForRun(this.database, runId);
      const routePlan = readTaskRequestRoutePlan(this.database, runId);
      if (run.status === "recovery_required"
        || hasFinalizationJournal
        || isBlockingAuthority(authority)
        || routePlan?.phase === "authority_acquired"
        || routePlan?.phase === "recovery_required") {
        markRunRecoveryRequired(this.database, runId);
        result.recoveryRequiredRunIds.push(runId);
        continue;
      }

      try {
        this.database.transaction(() => {
          if (routePlan?.phase === "planned") {
            updateTaskRequestRoutePlan(this.database, {
              runId,
              phase: "discarded",
              at,
            });
          }
          closeRunConversationWithoutAssistant(this.database, {
            sessionId: run.sessionId,
            conversationId: run.conversationId,
            runId,
            ...(run.taskBinding ? { taskId: run.taskBinding.taskId } : {}),
            at,
          });
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

function isBlockingAuthority(authority: MutationAuthorityRecord | undefined): boolean {
  return authority?.status === "active"
    || authority?.status === "verified"
    || authority?.status === "recovery_required";
}
