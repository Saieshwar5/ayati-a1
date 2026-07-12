export class SerializedWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Git Context Engine write queue is closed."));
    }

    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.drain();
  }
}
