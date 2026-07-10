export interface BackgroundFinalizationHooks {
  onError?: (error: unknown) => void | Promise<void>;
}

interface PendingFinalization {
  settled: Promise<void>;
}

export class BackgroundFinalizationCoordinator {
  private readonly pending = new Map<string, PendingFinalization>();

  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  start(
    key: string,
    work: () => Promise<unknown>,
    hooks: BackgroundFinalizationHooks = {},
  ): void {
    const previous = this.pending.get(key)?.settled ?? Promise.resolve();
    const operation = previous.then(work);
    const settled = operation.then(
      () => undefined,
      async (error: unknown) => {
        await hooks.onError?.(error);
      },
    );
    const entry = { settled };
    this.pending.set(key, entry);
    void settled.finally(() => {
      if (this.pending.get(key) === entry) {
        this.pending.delete(key);
      }
    });
  }

  async wait(key: string): Promise<void> {
    await this.pending.get(key)?.settled;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending.values()].map((entry) => entry.settled));
    }
  }
}
