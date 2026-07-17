import type { TaskCatalogEntry, TaskContextProjection } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import { readLegacyTaskContext } from "./legacy-task-context-reader.js";
import { readSimpleTaskContext } from "./simple-task-context-reader.js";

export interface TaskContextReadOptions {
  checkoutPath?: string;
  taskRoot?: string;
  includeReferencesSummary?: boolean;
}

export async function readTaskContext(
  task: TaskCatalogEntry,
  options: TaskContextReadOptions = {},
): Promise<TaskContextProjection> {
  if (task.layoutVersion === "legacy_independent_v0") {
    return await readLegacyTaskContext(task, options.checkoutPath);
  }
  if (!options.taskRoot) {
    throw new GitContextServiceError({
      code: "SERVICE_NOT_READY",
      message: "The configured V1 task root is required to read this task.",
      details: { taskId: task.taskId, layoutVersion: task.layoutVersion },
    });
  }
  return await readSimpleTaskContext(task, {
    taskRoot: options.taskRoot,
    includeReferencesSummary: options.includeReferencesSummary ?? false,
  });
}
