export type GitMemoryWriteBatchType =
  | "session_opened"
  | "main_conversation_appended"
  | "assistant_message_recorded"
  | "task_created"
  | "task_switched"
  | "task_routed"
  | "task_run_committed"
  | "session_checkpointed";

export type GitMemoryWriteBatchStatus = "pending" | "writing" | "committed" | "failed";

export interface GitMemoryWriteBatchRequest {
  sessionId: string;
  type: GitMemoryWriteBatchType;
  label?: string | undefined;
  createdAt?: string | undefined;
}

export interface GitMemoryWriteBatchSnapshot {
  id: string;
  sessionId: string;
  type: GitMemoryWriteBatchType;
  label: string;
  createdAt: string;
  status: GitMemoryWriteBatchStatus;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
}

export interface GitMemoryWriteQueueRunner {
  enqueue<T>(batch: GitMemoryWriteBatchRequest, run: () => Promise<T>): Promise<T>;
  getSessionWrites(sessionId: string): GitMemoryWriteBatchSnapshot[];
}

interface MutableGitMemoryWriteBatch {
  id: string;
  sessionId: string;
  type: GitMemoryWriteBatchType;
  label: string;
  createdAt: string;
  status: GitMemoryWriteBatchStatus;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
}

export class GitMemoryWriteQueue implements GitMemoryWriteQueueRunner {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly writesBySession = new Map<string, MutableGitMemoryWriteBatch[]>();
  private nextBatchNumber = 1;

  enqueue<T>(batch: GitMemoryWriteBatchRequest, run: () => Promise<T>): Promise<T> {
    const key = batch.sessionId.trim();
    const type = batch.type.trim();
    const label = (batch.label ?? batch.type).trim();
    if (!key) {
      throw new Error("Git memory write queue requires a session id.");
    }
    if (!type) {
      throw new Error("Git memory write queue requires an operation type.");
    }
    if (!label) {
      throw new Error("Git memory write queue requires an operation label.");
    }

    const write = this.createWrite({
      ...batch,
      sessionId: key,
      label,
    });
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(async () => {
      write.status = "writing";
      write.startedAt = new Date().toISOString();
      try {
        const result = await run();
        write.status = "committed";
        write.completedAt = new Date().toISOString();
        return result;
      } catch (error) {
        write.status = "failed";
        write.failedAt = new Date().toISOString();
        write.error = errorMessage(error);
        throw error;
      }
    });
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return current;
  }

  getSessionWrites(sessionId: string): GitMemoryWriteBatchSnapshot[] {
    const key = sessionId.trim();
    if (!key) {
      throw new Error("Git memory write queue requires a session id.");
    }
    return (this.writesBySession.get(key) ?? []).map(snapshotWrite);
  }

  private createWrite(batch: GitMemoryWriteBatchRequest & { label: string }): MutableGitMemoryWriteBatch {
    const write: MutableGitMemoryWriteBatch = {
      id: `GMW-${String(this.nextBatchNumber).padStart(6, "0")}`,
      sessionId: batch.sessionId,
      type: batch.type,
      label: batch.label,
      createdAt: batch.createdAt ?? new Date().toISOString(),
      status: "pending",
    };
    this.nextBatchNumber += 1;
    const writes = this.writesBySession.get(batch.sessionId) ?? [];
    writes.push(write);
    this.writesBySession.set(batch.sessionId, writes);
    return write;
  }
}

function snapshotWrite(write: MutableGitMemoryWriteBatch): GitMemoryWriteBatchSnapshot {
  return { ...write };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
