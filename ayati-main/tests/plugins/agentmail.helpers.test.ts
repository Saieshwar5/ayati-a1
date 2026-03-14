import { describe, expect, it } from "vitest";
import {
  buildWebhookListenerPath,
  normalizeWebhookPath,
  parseAgentMailWebhook,
  parseAllowedSenders,
  sanitizeEventIdForFileName,
} from "../../src/plugins/agentmail/helpers.js";

describe("AgentMail helpers", () => {
  it("normalizes webhook paths", () => {
    expect(normalizeWebhookPath(undefined)).toBe("/webhooks/agentmail");
    expect(normalizeWebhookPath("webhooks/agentmail/")).toBe("/webhooks/agentmail");
    expect(normalizeWebhookPath("//webhooks//agentmail//")).toBe("/webhooks/agentmail");
  });

  it("builds listener paths with optional tokens", () => {
    expect(buildWebhookListenerPath("/webhooks/agentmail", undefined)).toBe("/webhooks/agentmail");
    expect(buildWebhookListenerPath("/webhooks/agentmail", "secret-token")).toBe("/webhooks/agentmail/secret-token");
    expect(buildWebhookListenerPath("webhooks/agentmail/", "/secret-token/")).toBe("/webhooks/agentmail/secret-token");
  });

  it("parses sender allowlists into normalized emails", () => {
    expect(parseAllowedSenders(undefined)).toEqual([]);
    expect(parseAllowedSenders(" Alice@example.com,BOB@example.com ,, ")).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  it("sanitizes event ids for filesystem storage", () => {
    expect(sanitizeEventIdForFileName("evt:123/456")).toBe("evt-123-456");
  });

  it("normalizes AgentMail webhook payloads into system events", () => {
    const payload = {
      event_type: "message.received",
      event_id: "evt_123",
      message: {
        inbox_id: "ayati@agentmail.to",
        thread_id: "thd_123",
        message_id: "msg_123",
        from: [{ name: "Jane", email: "Jane@example.com" }],
        subject: "Need help",
        text: "Please check this request.",
        attachments: [{ attachment_id: "att_1", filename: "invoice.pdf", content_type: "application/pdf" }],
        timestamp: "2026-03-11T10:00:00Z",
      },
    };

    const parsed = parseAgentMailWebhook(payload, JSON.stringify(payload));

    expect(parsed).not.toBeNull();
    expect(parsed?.senderEmail).toBe("jane@example.com");
    expect(parsed?.systemEvent).toEqual({
      source: "agentmail",
      eventName: "message.received",
      eventId: "evt_123",
      receivedAt: "2026-03-11T10:00:00Z",
      summary: "Incoming email from jane@example.com with subject Need help",
      payload,
    });
  });
});
