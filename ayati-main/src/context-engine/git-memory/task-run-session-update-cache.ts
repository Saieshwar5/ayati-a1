import { createHash } from "node:crypto";
import type { SessionSnapshot } from "./session-snapshot.js";
import type { TaskRunCheckpoint } from "./task-run-checkpoint.js";

export type TaskRunSessionUpdateCacheEntry =
  | {
      status: "success";
      checkpoint: TaskRunCheckpoint;
      sessionSnapshot: SessionSnapshot;
      summaryMarkdown: string;
      checkpointTokens: number;
      snapshotTokens: number;
    }
  | {
      status: "failed";
      errors: string[];
    };

export interface TaskRunSessionUpdateCacheState {
  entries: Record<string, TaskRunSessionUpdateCacheEntry>;
}

const TASK_RUN_SESSION_UPDATE_PROMPT_VERSION = "task-run-session-update-v1";

export function createTaskRunSessionUpdateCache(): TaskRunSessionUpdateCacheState {
  return { entries: {} };
}

export function taskRunSessionUpdateCacheKey(input: {
  provider: string;
  model: string;
  checkpointId: string;
  sourceHash: string;
  generationInputHash: string;
  checkpointTokenBudget: number;
  snapshotTokenBudget: number;
  generatorInputCapacity?: number;
}): string {
  return [
    TASK_RUN_SESSION_UPDATE_PROMPT_VERSION,
    input.provider,
    input.model,
    input.checkpointId,
    input.sourceHash,
    input.generationInputHash,
    String(input.checkpointTokenBudget),
    String(input.snapshotTokenBudget),
    String(input.generatorInputCapacity ?? "default"),
  ].join(":");
}

export function hashTaskRunSessionUpdateInput(value: unknown): string {
  const serialized = JSON.stringify(value) ?? "undefined";
  return createHash("sha256").update(serialized).digest("hex");
}

export function readTaskRunSessionUpdateCache(
  cache: TaskRunSessionUpdateCacheState,
  key: string,
): TaskRunSessionUpdateCacheEntry | undefined {
  const entry = cache.entries[key];
  return entry ? structuredClone(entry) : undefined;
}

export function writeTaskRunSessionUpdateCache(
  cache: TaskRunSessionUpdateCacheState,
  key: string,
  entry: TaskRunSessionUpdateCacheEntry,
): void {
  cache.entries[key] = structuredClone(entry);
}
