import { describe, expect, it, vi } from "vitest";
import { createChatReplyChannel } from "../../src/app/chat-reply-channel.js";

describe("createChatReplyChannel", () => {
  it("keeps logical ownership separate from the transport reply target", () => {
    const onReply = vi.fn();
    const clientSupportsReplyStreaming = vi.fn(() => true);
    const channel = createChatReplyChannel({
      input: {
        clientId: "local",
        replyClientId: "transport-voice",
        messageId: "voice-message-1",
        channel: "voice",
        content: "hello",
        attachments: [],
      },
      onReply,
      clientSupportsReplyStreaming,
    });

    channel.send({ type: "reply", content: "Hello back." });

    expect(channel.clientId).toBe("transport-voice");
    expect(channel.supportsStreaming).toBe(true);
    expect(clientSupportsReplyStreaming).toHaveBeenCalledWith("transport-voice");
    expect(onReply).toHaveBeenCalledWith("transport-voice", {
      type: "reply",
      messageId: "voice-message-1",
      content: "Hello back.",
    });
  });
});
