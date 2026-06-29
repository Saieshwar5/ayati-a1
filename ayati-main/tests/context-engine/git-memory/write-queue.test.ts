import { describe, expect, it } from "vitest";
import { GitMemoryWriteQueue } from "../../../src/context-engine/git-memory/index.js";

describe("GitMemoryWriteQueue", () => {
  it("runs writes for one session in enqueue order", async () => {
    const queue = new GitMemoryWriteQueue();
    const events: string[] = [];
    const firstGate = deferred<void>();

    const first = queue.enqueue("S-20260628-local", "first", async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
      return "first";
    });
    const second = queue.enqueue("S-20260628-local", "second", async () => {
      events.push("second:start");
      return "second";
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    firstGate.resolve();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not block writes for different sessions", async () => {
    const queue = new GitMemoryWriteQueue();
    const events: string[] = [];
    const firstGate = deferred<void>();

    const first = queue.enqueue("S-20260628-local", "first", async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const second = queue.enqueue("S-20260629-local", "second", async () => {
      events.push("second:start");
    });

    await second;
    expect(events).toEqual(["first:start", "second:start"]);
    firstGate.resolve();
    await first;
  });

  it("continues later writes after a failed write", async () => {
    const queue = new GitMemoryWriteQueue();
    const events: string[] = [];

    const failed = queue.enqueue("S-20260628-local", "failed", async () => {
      events.push("failed:start");
      throw new Error("write failed");
    });
    const next = queue.enqueue("S-20260628-local", "next", async () => {
      events.push("next:start");
      return "next";
    });

    await expect(failed).rejects.toThrow("write failed");
    await expect(next).resolves.toBe("next");
    expect(events).toEqual(["failed:start", "next:start"]);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
