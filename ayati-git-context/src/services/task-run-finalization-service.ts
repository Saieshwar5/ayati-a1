import type {
  FinalizeTaskRunRequest,
  FinalizeTaskRunResponse,
  SessionRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { readTaskInitialization } from "../repositories/task-records.js";
import {
  SimpleTaskFinalizationService,
  type SimpleTaskFinalizationHook,
} from "./simple-task-finalization-service.js";

export class TaskRunFinalizationService {
  private readonly simpleTaskFinalization: SimpleTaskFinalizationService;

  constructor(
    private readonly database: ContextDatabase,
    taskRoot: string,
    hook?: SimpleTaskFinalizationHook,
  ) {
    this.simpleTaskFinalization = new SimpleTaskFinalizationService({
      database,
      taskRoot,
      ...(hook ? { hook } : {}),
    });
  }

  async finalize(
    input: FinalizeTaskRunRequest,
    session: SessionRef,
  ): Promise<FinalizeTaskRunResponse> {
    if (!/^T-\d{8}-\d{4}$/.test(input.taskId)) {
      throw invalidTaskId(input.taskId);
    }
    const task = readTaskInitialization(
      this.database,
      input.taskId,
    );
    if (!task?.head) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Task-run finalization requires an active V1 task repository.",
        details: { taskId: input.taskId },
      });
    }
    return await this.simpleTaskFinalization.finalize(input, session);
  }

  async recoverSimpleTaskFinalizations(at: string): Promise<void> {
    await this.simpleTaskFinalization.recoverCommittedFinalizations(at);
  }
}

function invalidTaskId(taskId: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message: "Task-run finalization supports only V1 T-* task repositories.",
    details: { taskId },
  });
}
