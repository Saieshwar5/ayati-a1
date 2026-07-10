import { describe, expect, it, vi } from "vitest";
import { BackgroundFinalizationCoordinator } from "../../src/app/background-finalization-coordinator.js";

describe("BackgroundFinalizationCoordinator", () => {
  it("waits for pending work and removes the settled barrier", async () => {
    const coordinator = new BackgroundFinalizationCoordinator();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = vi.fn(async () => {
      await gate;
    });

    coordinator.start("session-a", work);

    expect(coordinator.isPending("session-a")).toBe(true);
    let waited = false;
    const waiting = coordinator.wait("session-a").then(() => {
      waited = true;
    });
    await Promise.resolve();
    expect(waited).toBe(false);

    release();
    await waiting;

    expect(work).toHaveBeenCalledTimes(1);
    expect(coordinator.isPending("session-a")).toBe(false);
  });

  it("releases waiters and reports background failures", async () => {
    const coordinator = new BackgroundFinalizationCoordinator();
    let releaseRecovery = () => {};
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const onError = vi.fn(async () => {
      await recoveryGate;
    });

    coordinator.start("session-a", async () => {
      throw new Error("finalization failed");
    }, { onError });
    let waited = false;
    const waiting = coordinator.wait("session-a").then(() => {
      waited = true;
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(waited).toBe(false);

    releaseRecovery();
    await waiting;

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "finalization failed",
    }));
    expect(coordinator.isPending("session-a")).toBe(false);
  });

  it("serializes multiple finalizations for the same key", async () => {
    const coordinator = new BackgroundFinalizationCoordinator();
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    coordinator.start("session-a", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    coordinator.start("session-a", async () => {
      order.push("second");
    });
    await Promise.resolve();

    expect(order).toEqual(["first-start"]);
    release();
    await coordinator.drain();

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
