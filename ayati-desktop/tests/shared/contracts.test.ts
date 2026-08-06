import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_CONTENT_CHARS,
  parseDaemonServerMessage,
  parseReplyRenderedInput,
  parseSendChatInput,
} from "../../src/shared/contracts.js";

describe("desktop contracts", () => {
  it("parses streaming daemon envelopes without trusting unknown fields", () => {
    expect(parseDaemonServerMessage({
      type: "reply_done",
      turnId: "turn-1",
      messageId: "message-1",
      content: "Finished.",
      kind: "reply",
      runId: "run-1",
      commitStatus: "committed",
      ignored: "value",
    })).toEqual({
      type: "reply_done",
      turnId: "turn-1",
      messageId: "message-1",
      content: "Finished.",
      kind: "reply",
      runId: "run-1",
      commitStatus: "committed",
    });
  });

  it("keeps a renderable reply when optional metadata is from a newer protocol", () => {
    expect(parseDaemonServerMessage({
      type: "reply_done",
      turnId: "turn-2",
      content: "Still render me.",
      commitStatus: "future_status",
    })).toEqual({
      type: "reply_done",
      turnId: "turn-2",
      content: "Still render me.",
    });
  });

  it("rejects malformed or unsupported daemon envelopes", () => {
    expect(parseDaemonServerMessage({ type: "reply_delta", turnId: "turn-1", delta: "x" })).toBeNull();
    expect(parseDaemonServerMessage({ type: "unknown", content: "x" })).toBeNull();
    expect(parseDaemonServerMessage("not an envelope")).toBeNull();
  });

  it("validates bounded chat and rendered acknowledgement input", () => {
    expect(parseSendChatInput({ content: "  hello  " })).toEqual({ content: "hello" });
    expect(parseSendChatInput({ content: " " })).toBeNull();
    expect(parseSendChatInput({ content: "x".repeat(MAX_CHAT_CONTENT_CHARS + 1) })).toBeNull();

    expect(parseReplyRenderedInput({
      turnId: "turn-1",
      renderedAt: "2026-08-06T12:00:00.000Z",
    })).toEqual({
      turnId: "turn-1",
      renderedAt: "2026-08-06T12:00:00.000Z",
    });
    expect(parseReplyRenderedInput({ turnId: "turn-1", renderedAt: "later" })).toBeNull();
  });
});
