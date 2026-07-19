import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
  SessionRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { readTaskInitialization } from "../repositories/task-records.js";
import type { MutationBoundaryService } from "./mutation-boundary-service.js";
import {
  SimpleTaskFinalizationService,
  type SimpleTaskFinalizationHook,
} from "./simple-task-finalization-service.js";

export class TaskBoundFinalizationService {
  private readonly simpleTaskFinalization: SimpleTaskFinalizationService;

  constructor(
    private readonly database: ContextDatabase,
    taskRoot: string,
    mutationBoundary: MutationBoundaryService,
    hook?: SimpleTaskFinalizationHook,
  ) {
    this.simpleTaskFinalization = new SimpleTaskFinalizationService({
      database,
      taskRoot,
      mutationBoundary,
      ...(hook ? { hook } : {}),
    });
  }

  async finalize(
    input: FinalizeRunRequest,
    session: SessionRef,
  ): Promise<FinalizeRunResponse> {
    const run = readRunEvidence(this.database, input.runId);
    const taskId = run?.taskBinding?.taskId;
    if (!taskId || !/^T-\d{8}-\d{4}$/.test(taskId)) {
      throw invalidTaskId(taskId);
    }
    const task = readTaskInitialization(this.database, taskId);
    if (!task?.head) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Task-bound finalization requires an active V1 task repository.",
        details: { taskId },
      });
    }
    return await this.simpleTaskFinalization.finalize(input, session);
  }

  async recover(at: string): Promise<void> {
    await this.simpleTaskFinalization.recover(at);
  }
}

function invalidTaskId(taskId: string | undefined): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message: "Task-bound finalization supports only V1 T-* task repositories.",
    details: { taskId: taskId ?? null },
  });
}
