import { describe, expect, it, vi } from "vitest";
import { completeSessionLifecycle } from "../../src/app/session-lifecycle.js";
import { noopSessionMemory } from "../../src/memory/provider.js";
import type { SessionMemory } from "../../src/memory/types.js";

describe("completeSessionLifecycle", () => {
  it("returns missing_run when no run handle exists", async () => {
    await expect(completeSessionLifecycle({
      clientId: "c1",
      sessionMemory: noopSessionMemory,
      runHandle: null,
      status: "completed",
    })).resolves.toEqual({ completed: false, reason: "missing_run" });
  });

  it("returns missing_status when no final status exists", async () => {
    await expect(completeSessionLifecycle({
      clientId: "c1",
      sessionMemory: noopSessionMemory,
      runHandle: { sessionId: "s1", runId: "r1" },
      status: null,
    })).resolves.toEqual({ completed: false, reason: "missing_status" });
  });

  it("records lifecycle update and flushes persistence", async () => {
    const updateSessionLifecycle = vi.fn().mockResolvedValue(undefined);
    const flushPersistence = vi.fn().mockResolvedValue(undefined);
    const sessionMemory = {
      ...noopSessionMemory,
      updateSessionLifecycle,
      flushPersistence,
    } satisfies SessionMemory;

    const result = await completeSessionLifecycle({
      clientId: "c1",
      sessionMemory,
      runHandle: { sessionId: "s1", runId: "r1" },
      status: "completed",
    });

    expect(result).toEqual({
      completed: true,
      runId: "r1",
      status: "completed",
    });
    expect(updateSessionLifecycle).toHaveBeenCalledWith("c1", {
      runId: "r1",
      sessionId: "s1",
      timezone: null,
      status: "completed",
    });
    expect(flushPersistence).toHaveBeenCalledTimes(1);
  });
});
