import type { MemoryRunHandle, SessionMemory } from "../memory/types.js";
import { devWarn } from "../shared/index.js";

export type AppRunStatus = "completed" | "failed" | "stuck";

export type SessionLifecycleCompletionResult =
  | {
      completed: false;
      reason: "missing_run" | "missing_status";
    }
  | {
      completed: true;
      runId: string;
      status: AppRunStatus;
    };

export interface CompleteSessionLifecycleInput {
  clientId: string;
  sessionMemory: SessionMemory;
  runHandle: MemoryRunHandle | null;
  status: AppRunStatus | null;
}

export async function completeSessionLifecycle(
  input: CompleteSessionLifecycleInput,
): Promise<SessionLifecycleCompletionResult> {
  if (!input.runHandle) {
    return { completed: false, reason: "missing_run" };
  }
  if (!input.status) {
    return { completed: false, reason: "missing_status" };
  }

  try {
    await input.sessionMemory.updateSessionLifecycle?.(input.clientId, {
      runId: input.runHandle.runId,
      sessionId: input.runHandle.sessionId,
      timezone: null,
      status: input.status,
    });
    await input.sessionMemory.flushPersistence?.();
  } catch (err) {
    devWarn("Session lifecycle update failed:", err instanceof Error ? err.message : String(err));
  }

  return {
    completed: true,
    runId: input.runHandle.runId,
    status: input.status,
  };
}
