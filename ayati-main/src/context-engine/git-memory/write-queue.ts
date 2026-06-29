export interface GitMemoryWriteQueueRunner {
  enqueue<T>(sessionId: string, label: string, run: () => Promise<T>): Promise<T>;
}

export class GitMemoryWriteQueue implements GitMemoryWriteQueueRunner {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(sessionId: string, label: string, run: () => Promise<T>): Promise<T> {
    const key = sessionId.trim();
    const operation = label.trim();
    if (!key) {
      throw new Error("Git memory write queue requires a session id.");
    }
    if (!operation) {
      throw new Error("Git memory write queue requires an operation label.");
    }

    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(run);
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
}
