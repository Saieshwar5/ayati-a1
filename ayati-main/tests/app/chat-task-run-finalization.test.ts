import { describe, expect, it, vi } from "vitest";
import { ChatTaskRunFinalizationScheduler } from "../../src/app/chat-task-run-finalization.js";

describe("ChatTaskRunFinalizationScheduler", () => {
  it("does not schedule finalization when assistant persistence fails", async () => {
    const scheduler = new ChatTaskRunFinalizationScheduler();
    const finalize = vi.fn(async () => "committed" as const);

    expect(await scheduler.schedule({
      key: "session-a",
      persistAssistant: async () => false,
      finalize,
      recover: async () => {},
      onStatus: () => {},
    })).toBe(false);

    expect(finalize).not.toHaveBeenCalled();
    expect(scheduler.isPending("session-a")).toBe(false);
  });

  it("reports the final commit status after scheduled work settles", async () => {
    const scheduler = new ChatTaskRunFinalizationScheduler();
    const onStatus = vi.fn();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(await scheduler.schedule({
      key: "session-a",
      persistAssistant: async () => true,
      finalize: async () => {
        await gate;
        return "committed";
      },
      recover: async () => {},
      onStatus,
    })).toBe(true);
    expect(scheduler.isPending("session-a")).toBe(true);
    expect(onStatus).not.toHaveBeenCalled();

    release();
    await scheduler.wait("session-a");

    expect(onStatus).toHaveBeenCalledWith("committed");
  });

  it("attempts recovery before releasing a failed finalization", async () => {
    const scheduler = new ChatTaskRunFinalizationScheduler();
    const order: string[] = [];

    await scheduler.schedule({
      key: "session-a",
      persistAssistant: async () => true,
      finalize: async () => {
        throw new Error("commit failed");
      },
      recover: async () => {
        order.push("recover");
      },
      onStatus: (status) => {
        order.push(status);
      },
      onError: () => {
        order.push("error");
      },
    });
    await scheduler.wait("session-a");

    expect(order).toEqual(["recover", "failed", "error"]);
    expect(scheduler.isPending("session-a")).toBe(false);
  });
});
