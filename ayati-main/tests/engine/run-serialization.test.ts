import { describe, expect, it, vi } from "vitest";
import type { AyatiSystemEvent } from "../../src/core/contracts/plugin.js";
import type { ChatTurnRuntime } from "../../src/ivec/chat-turn-runtime.js";
import { IVecEngine } from "../../src/ivec/index.js";
import type { SystemEventRuntime } from "../../src/ivec/system-event-runtime.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function systemEvent(): AyatiSystemEvent {
  return {
    type: "system_event",
    eventId: "event-1",
    source: "test",
    eventName: "run",
    receivedAt: "2026-07-27T00:00:00.000Z",
    summary: "Run the queued system event.",
    payload: {},
  };
}

describe("IVecEngine global run serialization", () => {
  it("runs chat and system-event harness lifecycles one at a time", async () => {
    const chatGate = deferred();
    const events: string[] = [];
    const chatTurnRuntime: ChatTurnRuntime = {
      processChat: vi.fn(async () => {
        events.push("chat:start");
        await chatGate.promise;
        events.push("chat:end");
      }),
      drain: vi.fn(async () => undefined),
    };
    const systemEventRuntime: SystemEventRuntime = {
      processSystemEvent: vi.fn(async () => {
        events.push("system:start");
        events.push("system:end");
      }),
    };
    const engine = new IVecEngine({ chatTurnRuntime, systemEventRuntime });

    engine.handleMessage("cli", { type: "chat", content: "Create the website." });
    await vi.waitFor(() => expect(events).toEqual(["chat:start"]));

    const systemRun = engine.handleSystemEvent("system", systemEvent());
    await Promise.resolve();
    expect(systemEventRuntime.processSystemEvent).not.toHaveBeenCalled();

    chatGate.resolve();
    await systemRun;

    expect(events).toEqual([
      "chat:start",
      "chat:end",
      "system:start",
      "system:end",
    ]);
    await engine.stop();
  });

  it("starts the next run after an earlier run fails", async () => {
    const events: string[] = [];
    const chatTurnRuntime: ChatTurnRuntime = {
      processChat: vi.fn(async () => {
        events.push("chat:failed");
        throw new Error("chat failed");
      }),
      drain: vi.fn(async () => undefined),
    };
    const systemEventRuntime: SystemEventRuntime = {
      processSystemEvent: vi.fn(async () => {
        events.push("system:started");
      }),
    };
    const engine = new IVecEngine({ chatTurnRuntime, systemEventRuntime });

    engine.handleMessage("cli", { type: "chat", content: "Fail this run." });
    await engine.handleSystemEvent("system", systemEvent());

    expect(events).toEqual(["chat:failed", "system:started"]);
    await engine.stop();
  });

  it("waits for the active run before stopping the engine", async () => {
    const chatGate = deferred();
    const chatTurnRuntime: ChatTurnRuntime = {
      processChat: vi.fn(async () => {
        await chatGate.promise;
      }),
      drain: vi.fn(async () => undefined),
    };
    const engine = new IVecEngine({ chatTurnRuntime });

    engine.handleMessage("cli", { type: "chat", content: "Keep running." });
    await vi.waitFor(() => expect(chatTurnRuntime.processChat).toHaveBeenCalledOnce());

    let stopped = false;
    const stop = engine.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    chatGate.resolve();
    await stop;

    expect(stopped).toBe(true);
    expect(chatTurnRuntime.drain).toHaveBeenCalledOnce();
  });
});
