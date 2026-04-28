import { describe, expect, it } from "vitest";
import {
  buildSystemEventFromNylasNotification,
  computeNylasSignature,
  extractGrantProfile,
  normalizeWebhookPath,
  parseNylasWebhookNotifications,
  verifyNylasSignature,
} from "../../src/plugins/nylas-mail/helpers.js";

describe("nylas-mail helpers", () => {
  it("normalizes webhook paths", () => {
    expect(normalizeWebhookPath(undefined)).toBe("/webhooks/nylas-mail");
    expect(normalizeWebhookPath("webhooks/nylas-mail/")).toBe("/webhooks/nylas-mail");
    expect(normalizeWebhookPath("//webhooks//nylas-mail//")).toBe("/webhooks/nylas-mail");
  });

  it("computes and verifies HMAC signatures using the raw request body", () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = computeNylasSignature("secret", body);

    expect(verifyNylasSignature("secret", body, signature)).toBe(true);
    expect(verifyNylasSignature("secret", body, "deadbeef")).toBe(false);
  });

  it("parses delta notifications and builds safe system events", () => {
    const payload = {
      webhook_delivery_attempt: 2,
      deltas: [{
        id: "evt_123",
        type: "message.created",
        source: "/google/messages",
        object: "message",
        object_data: {
          id: "msg_123",
          thread_id: "thread_123",
          grant_id: "grant_123",
          application_id: "app_123",
          subject: "Need help",
          from: [{ name: "Jane", email: "jane@example.com" }],
          to: [{ email: "agent@example.com" }],
          body: "<p>Please <strong>review</strong> this.</p>",
          snippet: "Please review this.",
          attachments: [{ id: "att_1" }],
          date: 1710000000,
        },
      }],
    };

    const notifications = parseNylasWebhookNotifications(payload, JSON.stringify(payload));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(expect.objectContaining({
      eventName: "message.created",
      eventId: "evt_123",
      grantId: "grant_123",
      messageId: "msg_123",
      threadId: "thread_123",
      webhookDeliveryAttempt: 2,
    }));

    const systemEvent = buildSystemEventFromNylasNotification(notifications[0]!, notifications[0]!.message, {
      email: "agent@example.com",
      provider: "google",
    });

    expect(systemEvent).toEqual({
      source: "nylas-mail",
      eventName: "message.created",
      eventId: "evt_123",
      receivedAt: "2024-03-09T16:00:00.000Z",
      summary: "Incoming email from jane@example.com with subject Need help",
      intent: {
        kind: "task",
        eventClass: "message_received",
        trustTier: "external",
        effectLevel: "observe",
        requestedAction: "review_incoming_message",
        createdBy: "external",
      },
      payload: {
        notificationType: "message.created",
        webhookEventId: "evt_123",
        webhookDeliveryAttempt: 2,
        source: "/google/messages",
        grantId: "grant_123",
        applicationId: "app_123",
        truncated: false,
        metadataOnly: false,
        transformed: false,
        cleaned: false,
        messageId: "msg_123",
        threadId: "thread_123",
        provider: "google",
        mailboxEmail: "agent@example.com",
        subject: "Need help",
        sender: { name: "Jane", email: "jane@example.com" },
        from: [{ name: "Jane", email: "jane@example.com" }],
        to: [{ email: "agent@example.com" }],
        sentAt: "2024-03-09T16:00:00.000Z",
        receivedAt: "2024-03-09T16:00:00.000Z",
        hasAttachments: true,
        attachmentCount: 1,
        snippet: "Please review this.",
        bodyPreview: "Please review this.",
      },
    });
  });

  it("extracts mailbox identity from grant payloads", () => {
    expect(extractGrantProfile({
      data: {
        id: "grant_123",
        provider: "google",
        settings: {
          email: "agent@example.com",
        },
      },
    })).toEqual({
      email: "agent@example.com",
      provider: "google",
    });
  });
});
