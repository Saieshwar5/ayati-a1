import type { TaskCatalogEntry, TaskContextProjection } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import { readSimpleTaskContext } from "./simple-task-context-reader.js";

export interface TaskContextReadOptions {
  taskRoot?: string;
  includeReferencesSummary?: boolean;
}

export async function readTaskContext(
  task: TaskCatalogEntry,
  options: TaskContextReadOptions = {},
): Promise<TaskContextProjection> {
  if (!options.taskRoot) {
    throw new GitContextServiceError({
      code: "TASK_NOT_FOUND",
      message: "The V1 task repository root is unavailable.",
      details: { taskId: task.taskId },
    });
  }
  return await readSimpleTaskContext(task, {
    taskRoot: options.taskRoot,
    includeReferencesSummary: options.includeReferencesSummary ?? false,
  });
}
