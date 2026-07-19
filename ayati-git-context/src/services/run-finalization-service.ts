import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
  SessionRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { readRunEvidence } from "../repositories/run-records.js";
import type { TaskBoundFinalizationService } from "./task-bound-finalization-service.js";
import type { UnboundRunFinalizationService } from "./unbound-run-finalization-service.js";

export class RunFinalizationService {
  constructor(private readonly options: {
    database: ContextDatabase;
    unbound: UnboundRunFinalizationService;
    taskBound: TaskBoundFinalizationService;
  }) {}

  async finalize(
    input: FinalizeRunRequest,
    session: SessionRef,
  ): Promise<FinalizeRunResponse> {
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run || run.sessionId !== input.sessionId) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Finalization requires the matching run and session.",
        details: { sessionId: input.sessionId, runId: input.runId },
      });
    }
    if (run.taskBinding) {
      if (!input.task?.completion) {
        throw new GitContextServiceError({
          code: "INVALID_REQUEST",
          message: "Task-bound finalization requires task completion evidence.",
          details: { runId: input.runId, taskBinding: run.taskBinding },
        });
      }
      return await this.options.taskBound.finalize(input, session);
    }
    if (input.task) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Unbound run finalization cannot submit task completion evidence.",
        details: { runId: input.runId },
      });
    }
    return await this.options.unbound.finalize(input, session);
  }

  async recover(at: string): Promise<void> {
    await this.options.unbound.recover(at);
    await this.options.taskBound.recover(at);
  }
}
