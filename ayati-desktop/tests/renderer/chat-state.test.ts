import { describe, expect, it } from "vitest";
import {
  initialChatState,
  reduceChatState,
} from "../../src/renderer/chat-state.js";

describe("desktop chat state", () => {
  it("reduces one submitted and streamed daemon turn", () => {
    let state = reduceChatState(initialChatState, {
      type: "chat_submitted",
      content: "Explain the repository.",
      receipt: {
        messageId: "message-1",
        submittedAt: "2026-08-06T12:00:00.000Z",
      },
    });
    state = reduceChatState(state, {
      type: "server_message",
      receivedAt: "2026-08-06T12:00:01.000Z",
      message: {
        type: "chat_accepted",
        messageId: "message-1",
        queued: true,
        queuePosition: 2,
      },
    });
    expect(state.queuePosition).toBe(2);

    state = reduceChatState(state, {
      type: "server_message",
      receivedAt: "2026-08-06T12:00:02.000Z",
      message: {
        type: "reply_started",
        turnId: "turn-1",
        runId: "run-1",
      },
    });
    state = reduceChatState(state, {
      type: "server_message",
      receivedAt: "2026-08-06T12:00:03.000Z",
      message: {
        type: "reply_delta",
        turnId: "turn-1",
        seq: 0,
        delta: "Ayati ",
      },
    });
    state = reduceChatState(state, {
      type: "server_message",
      receivedAt: "2026-08-06T12:00:04.000Z",
      message: {
        type: "reply_delta",
        turnId: "turn-1",
        seq: 1,
        delta: "is ready.",
      },
    });
    state = reduceChatState(state, {
      type: "server_message",
      receivedAt: "2026-08-06T12:00:05.000Z",
      message: {
        type: "reply_done",
        turnId: "turn-1",
        runId: "run-1",
        content: "Ayati is ready.",
        commitStatus: "not_required",
      },
    });

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "Explain the repository.",
    });
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: "Ayati is ready.",
      streaming: false,
      runId: "run-1",
      commitStatus: "not_required",
    });
    expect(state.isAgentActive).toBe(false);
    expect(state.queuePosition).toBeUndefined();
  });

  it("keeps bounded progress outside conversation history", () => {
    let state = initialChatState;
    for (let index = 0; index < 10; index += 1) {
      state = reduceChatState(state, {
        type: "server_message",
        receivedAt: "2026-08-06T12:00:00.000Z",
        message: { type: "progress", content: `step ${index}` },
      });
    }
    expect(state.progressLines).toHaveLength(8);
    expect(state.progressLines[0]).toBe("step 2");
    expect(state.messages).toHaveLength(0);

    state = reduceChatState(state, {
      type: "server_message",
      receivedAt: "2026-08-06T12:01:00.000Z",
      message: { type: "error", content: "Provider unavailable." },
    });
    expect(state.progressLines).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({
      kind: "error",
      content: "Provider unavailable.",
    });
  });

  it("ends activity only for a final notification", () => {
    const active = { ...initialChatState, isAgentActive: true, progressLines: ["working"] };
    const interim = reduceChatState(active, {
      type: "server_message",
      receivedAt: "2026-08-06T12:00:00.000Z",
      message: { type: "notification", content: "Still working." },
    });
    expect(interim.isAgentActive).toBe(true);
    expect(interim.progressLines).toEqual(["working"]);

    const final = reduceChatState(interim, {
      type: "server_message",
      receivedAt: "2026-08-06T12:00:01.000Z",
      message: { type: "notification", content: "Done.", final: true },
    });
    expect(final.isAgentActive).toBe(false);
    expect(final.progressLines).toEqual([]);
  });
});
