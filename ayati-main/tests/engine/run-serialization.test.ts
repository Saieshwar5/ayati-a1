import { describe, expect, it, vi } from "vitest";
import type { ChatTurnRuntime } from "../../src/ivec/chat-turn-runtime.js";
import { IVecEngine } from "../../src/ivec/index.js";

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

describe("IVecEngine global run serialization", () => {
  it("returns queue receipts, routes replies independently, and suppresses duplicate message IDs", async () => {
    const chatGate = deferred();
    const chatTurnRuntime: ChatTurnRuntime = {
      processChat: vi.fn(async () => await chatGate.promise),
    };
    const engine = new IVecEngine({ chatTurnRuntime });

    const first = engine.handleMessage("local", {
      type: "chat",
      messageId: "message-1",
      content: "First",
    }, {
      replyClientId: "transport-1",
      channel: "cli",
    });
    const duplicate = engine.handleMessage("local", {
      type: "chat",
      messageId: "message-1",
      content: "First",
    }, {
      replyClientId: "transport-1",
      channel: "cli",
    });
    const second = engine.handleMessage("local", {
      type: "chat",
      messageId: "message-2",
      content: "Second",
    }, {
      replyClientId: "transport-2",
      channel: "voice",
    });

    expect(first).toEqual({
      type: "chat_accepted",
      messageId: "message-1",
      queued: false,
      queuePosition: 1,
    });
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(second).toEqual({
      type: "chat_accepted",
      messageId: "message-2",
      queued: true,
      queuePosition: 2,
    });
    await vi.waitFor(() => expect(chatTurnRuntime.processChat).toHaveBeenCalledTimes(1));
    expect(chatTurnRuntime.processChat).toHaveBeenNthCalledWith(1, {
      clientId: "local",
      replyClientId: "transport-1",
      messageId: "message-1",
      channel: "cli",
      content: "First",
      attachments: [],
    });

    chatGate.resolve();
    await engine.stop();
    expect(chatTurnRuntime.processChat).toHaveBeenNthCalledWith(2, {
      clientId: "local",
      replyClientId: "transport-2",
      messageId: "message-2",
      channel: "voice",
      content: "Second",
      attachments: [],
    });
  });

  it("runs chat harness lifecycles one at a time", async () => {
    const chatGate = deferred();
    const events: string[] = [];
    const chatTurnRuntime: ChatTurnRuntime = {
      processChat: vi.fn(async (input) => {
        events.push(`${input.content}:start`);
        if (input.content === "First") await chatGate.promise;
        events.push(`${input.content}:end`);
      }),
    };
    const engine = new IVecEngine({ chatTurnRuntime });

    engine.handleMessage("cli", { type: "chat", content: "First" });
    engine.handleMessage("cli", { type: "chat", content: "Second" });
    await vi.waitFor(() => expect(events).toEqual(["First:start"]));

    expect(chatTurnRuntime.processChat).toHaveBeenCalledTimes(1);

    chatGate.resolve();
    await engine.stop();

    expect(events).toEqual([
      "First:start",
      "First:end",
      "Second:start",
      "Second:end",
    ]);
  });

  it("starts the next run after an earlier run fails", async () => {
    const events: string[] = [];
    let call = 0;
    const chatTurnRuntime: ChatTurnRuntime = {
      processChat: vi.fn(async () => {
        call++;
        if (call === 1) {
          events.push("first:failed");
          throw new Error("chat failed");
        }
        events.push("second:started");
      }),
    };
    const engine = new IVecEngine({ chatTurnRuntime });

    engine.handleMessage("cli", { type: "chat", content: "Fail this run." });
    engine.handleMessage("cli", { type: "chat", content: "Run next." });

    await vi.waitFor(() => expect(events).toEqual(["first:failed", "second:started"]));
    await engine.stop();
  });

  it("waits for the active run before stopping the engine", async () => {
    const chatGate = deferred();
    const chatTurnRuntime: ChatTurnRuntime = {
      processChat: vi.fn(async () => {
        await chatGate.promise;
      }),
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
  });
});
