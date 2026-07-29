export class AgentRunQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  isBusy(): boolean {
    return this.pending > 0;
  }

  size(): number {
    return this.pending;
  }

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const run = this.tail.then(async () => {
      try {
        return await work();
      } finally {
        this.pending -= 1;
      }
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
