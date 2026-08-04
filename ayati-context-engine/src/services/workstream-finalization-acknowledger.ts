import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import { clearAgentStreamWorkstreamFocus } from "../repositories/agent-stream-records.js";
import { insertWorkstreamProgressProjection } from "../repositories/workstream-progress-records.js";
import {
  readSharedWorkstreamRepositoryState,
  updateSharedWorkstreamRepositoryState,
} from "../repositories/workstream-repository-state-records.js";
import {
  synchronizeCurrentWorkstreamRequest,
  writeWorkstreamRequestProjection,
} from "../repositories/workstream-request-records.js";
import {
  finalizeRunRecord,
  readRunEvidence,
} from "../repositories/run-records.js";
import type {
  WorkstreamFinalizationRecord,
} from "../repositories/workstream-finalization-records.js";
import {
  updateWorkstreamFinalization,
} from "../repositories/workstream-finalization-records.js";
import {
  readWorkstreamInitialization,
  updateWorkstreamProjection,
} from "../repositories/workstream-records.js";
import {
  writeWorkstreamDiscoveryProjection,
} from "../repositories/workstream-discovery-records.js";
import {
  readWorkstreamRequestRoutePlan,
  updateWorkstreamRequestRoutePlan,
} from "../repositories/workstream-request-route-plan-records.js";
import {
  validateWorkstreamRepository,
  type WorkstreamRepositoryValidation,
} from "../workstreams/workstream-repository-validator.js";

export async function validateCommittedWorkstreamFinalization(input: {
  database: ContextDatabase;
  workstreamRoot: string;
  record: WorkstreamFinalizationRecord;
  head: string;
}): Promise<WorkstreamRepositoryValidation> {
  const workstream = readWorkstreamInitialization(
    input.database,
    input.record.workstreamId,
  );
  if (!workstream) throw recovery("Committed workstream is missing from the catalog.");
  const validation = await validateWorkstreamRepository({
    workstreamRoot: input.workstreamRoot,
    contextRepositoryPath: workstream.contextRepositoryPath,
    expectedWorkstreamId: input.record.workstreamId,
    requestReadMode: "all",
  });
  if (validation.head !== input.head
    || validation.repositoryHead !== input.head
    || validation.health !== "ready") {
    throw recovery("Committed workstream context did not validate cleanly.");
  }
  const progressEntries = validation.progress.entries.filter(
    (entry) => entry.runId === input.record.runId,
  );
  const progressEntry = progressEntries[0];
  if (progressEntries.length !== 1
    || progressEntry?.requestId !== input.record.boundRequestId
    || progressEntry.outcome !== input.record.outcome
    || progressEntry.at !== input.record.createdAt) {
    throw recovery("Committed workstream progress does not match the finalized run.", {
      runId: input.record.runId,
      requestId: input.record.boundRequestId,
      outcome: input.record.outcome,
    });
  }
  const request = validation.requests.find(
    (entry) => entry.id === input.record.boundRequestId,
  );
  if (!request) throw recovery("Committed workstream request is missing.");
  if (input.record.requestEffect.kind === "complete" && request.status !== "done") {
    throw recovery("Completed run did not persist a completed request.");
  }
  if (input.record.requestEffect.kind === "block" && request.status !== "blocked") {
    throw recovery("Blocked run did not persist a blocked request.");
  }
  if (input.record.requestEffect.kind === "drop" && request.status !== "dropped") {
    throw recovery("Dropped request lifecycle effect was not persisted.");
  }
  return validation;
}

export function acknowledgeWorkstreamFinalization(input: {
  database: ContextDatabase;
  record: WorkstreamFinalizationRecord;
  commit: { head: string; created: boolean };
  validation: WorkstreamRepositoryValidation;
  at: string;
}): void {
  input.database.transaction(() => {
    const { record, commit, validation, at } = input;
    if (!commit.created || !record.plan.commitRequired) {
      throw new Error("Every finalized retained bound run must create one context commit.");
    }
    const repository = readSharedWorkstreamRepositoryState(input.database);
    if (!repository) throw new Error("Shared workstream repository state is unavailable.");
    if (repository.head === record.baseHead) {
      updateSharedWorkstreamRepositoryState(input.database, {
        expectedHead: record.baseHead,
        head: commit.head,
        health: "ready",
        at,
      });
    } else if (repository.head !== commit.head) {
      throw new Error("Shared repository HEAD cannot acknowledge the finalization commit.");
    }
    for (const request of validation.requests) {
      writeWorkstreamRequestProjection(input.database, {
        request,
        lastRunId: request.id === record.boundRequestId ? record.runId : undefined,
        lastActivityAt: request.id === record.boundRequestId ? at : request.updatedAt,
      });
    }
    synchronizeCurrentWorkstreamRequest(input.database, record.workstreamId);
    const progressEntry = validation.progress.entries.find(
      (entry) => entry.runId === record.runId,
    );
    if (!progressEntry) throw new Error("Finalized progress entry is unavailable.");
    insertWorkstreamProgressProjection(input.database, {
      workstreamId: record.workstreamId,
      entry: progressEntry,
      commit: commit.head,
    });
    const current = validation.currentRequest;
    updateWorkstreamProjection(input.database, {
      workstreamId: record.workstreamId,
      title: validation.workstreamCard.title,
      aliases: validation.workstreamCard.aliases,
      purpose: validation.workstreamCard.purpose,
      lifecycleStatus: validation.workstreamCard.status,
      currentRequestId: current?.id ?? null,
      currentSnapshot: validation.workstreamCard.currentSnapshot,
      currentFocus: validation.workstreamCard.currentFocus,
      blockers: validation.workstreamCard.blockers,
      lastRunId: record.runId,
      lastCommit: commit.head,
      at,
    });
    writeWorkstreamDiscoveryProjection(input.database, {
      workstreamId: record.workstreamId,
      expectedHead: commit.head,
      title: validation.workstreamCard.title,
      objective: validation.workstreamCard.purpose,
      aliases: validation.workstreamCard.aliases,
      currentSnapshot: validation.workstreamCard.currentSnapshot,
      currentFocus: validation.workstreamCard.currentFocus,
      importantFindings: validation.workstreamCard.importantFindings,
      lifecycleStatus: validation.workstreamCard.status,
      repositoryHealth: validation.health,
      ...(current ? {
        currentRequest: {
          id: current.id,
          title: current.title,
          status: current.status,
          searchText: [current.title, current.request].join("\n"),
        },
      } : {}),
    });
    const finalizedRequest = validation.requests.find(
      (request) => request.id === record.boundRequestId,
    );
    if (finalizedRequest?.status === "done" || finalizedRequest?.status === "dropped") {
      clearAgentStreamWorkstreamFocus(input.database, {
        streamId: record.streamId,
        workstreamId: record.workstreamId,
        requestId: record.boundRequestId,
        at,
      });
    }
    const run = readRunEvidence(input.database, record.runId);
    if (run?.status === "running" || run?.status === "recovery_required") {
      finalizeRunRecord(input.database, {
        runId: record.runId,
        outcome: record.outcome,
        stopReason: record.stopReason,
        at,
      });
    }
    const routePlan = readWorkstreamRequestRoutePlan(input.database, record.runId);
    if (routePlan) {
      updateWorkstreamRequestRoutePlan(input.database, {
        runId: record.runId,
        phase: "committed",
        commitHead: commit.head,
        at,
      });
    }
    updateWorkstreamFinalization(input.database, {
      runId: record.runId,
      phase: "completed",
      commitHead: commit.head,
      commitCreated: commit.created,
      at,
    });
  });
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
