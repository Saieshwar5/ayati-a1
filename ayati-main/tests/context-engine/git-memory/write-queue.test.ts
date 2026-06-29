import { describe, expect, it } from "vitest";
import { GitMemoryWriteQueue } from "../../../src/context-engine/git-memory/index.js";

describe("GitMemoryWriteQueue", () => {
  it("tracks write batch lifecycle status", async () => {
    const queue = new GitMemoryWriteQueue();
    const gate = deferred<void>();

    const write = queue.enqueue({
      sessionId: "S-20260628-local",
      type: "main_conversation_appended",
      label: "first",
      createdAt: "2026-06-28T09:00:00.000Z",
    }, async () => {
      await gate.promise;
      return "first";
    });

    expect(queue.getSessionWrites("S-20260628-local")).toMatchObject([{
      id: "GMW-000001",
      sessionId: "S-20260628-local",
      type: "main_conversation_appended",
      label: "first",
      createdAt: "2026-06-28T09:00:00.000Z",
      status: "pending",
    }]);

    await Promise.resolve();
    expect(queue.getSessionWrites("S-20260628-local")).toMatchObject([{
      status: "writing",
    }]);

    gate.resolve();
    await expect(write).resolves.toBe("first");
    expect(queue.getSessionWrites("S-20260628-local")).toMatchObject([{
      status: "committed",
    }]);
  });

  it("runs writes for one session in enqueue order", async () => {
    const queue = new GitMemoryWriteQueue();
    const events: string[] = [];
    const firstGate = deferred<void>();

    const first = queue.enqueue({
      sessionId: "S-20260628-local",
      type: "main_conversation_appended",
      label: "first",
    }, async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
      return "first";
    });
    const second = queue.enqueue({
      sessionId: "S-20260628-local",
      type: "assistant_message_recorded",
      label: "second",
    }, async () => {
      events.push("second:start");
      return "second";
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    firstGate.resolve();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(queue.getSessionWrites("S-20260628-local").map((write) => write.status))
      .toEqual(["committed", "committed"]);
  });

  it("does not block writes for different sessions", async () => {
    const queue = new GitMemoryWriteQueue();
    const events: string[] = [];
    const firstGate = deferred<void>();

    const first = queue.enqueue({
      sessionId: "S-20260628-local",
      type: "main_conversation_appended",
      label: "first",
    }, async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const second = queue.enqueue({
      sessionId: "S-20260629-local",
      type: "main_conversation_appended",
      label: "second",
    }, async () => {
      events.push("second:start");
    });

    await second;
    expect(events).toEqual(["first:start", "second:start"]);
    firstGate.resolve();
    await first;
    expect(queue.getSessionWrites("S-20260628-local")).toHaveLength(1);
    expect(queue.getSessionWrites("S-20260629-local")).toHaveLength(1);
  });

  it("continues later writes after a failed write", async () => {
    const queue = new GitMemoryWriteQueue();
    const events: string[] = [];

    const failed = queue.enqueue({
      sessionId: "S-20260628-local",
      type: "task_run_committed",
      label: "failed",
    }, async () => {
      events.push("failed:start");
      throw new Error("write failed");
    });
    const next = queue.enqueue({
      sessionId: "S-20260628-local",
      type: "session_checkpointed",
      label: "next",
    }, async () => {
      events.push("next:start");
      return "next";
    });

    await expect(failed).rejects.toThrow("write failed");
    await expect(next).resolves.toBe("next");
    expect(events).toEqual(["failed:start", "next:start"]);
    expect(queue.getSessionWrites("S-20260628-local")).toMatchObject([
      { status: "failed", error: "write failed" },
      { status: "committed" },
    ]);
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
