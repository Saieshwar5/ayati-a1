import { describe, expect, it } from "vitest";
import { AgentMailAdapter } from "../../src/plugins/agentmail/adapter.js";

describe("AgentMailAdapter", () => {
  it("normalizes supported mail webhooks into canonical events", () => {
    const adapter = new AgentMailAdapter({ allowedSenders: [] });
    const normalized = adapter.normalize({
      source: "agentmail",
      clientId: "local",
      body: JSON.stringify({
        event_type: "message.received",
        event_id: "evt_123",
        message: {
          from: [{ email: "jane@example.com" }],
          subject: "Need help",
          timestamp: "2026-03-11T10:00:00Z",
        },
      }),
      payload: {
        event_type: "message.received",
        event_id: "evt_123",
        message: {
          from: [{ email: "jane@example.com" }],
          subject: "Need help",
          timestamp: "2026-03-11T10:00:00Z",
        },
      },
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toEqual(expect.objectContaining({
      source: "agentmail",
      eventName: "message.received",
      eventId: "evt_123",
    }));
  });

  it("filters senders when allowlist is configured", () => {
    const adapter = new AgentMailAdapter({ allowedSenders: ["boss@example.com"] });
    const normalized = adapter.normalize({
      source: "agentmail",
      clientId: "local",
      body: JSON.stringify({
        event_type: "message.received",
        event_id: "evt_123",
        message: {
          from: [{ email: "jane@example.com" }],
          subject: "Need help",
          timestamp: "2026-03-11T10:00:00Z",
        },
      }),
      payload: {
        event_type: "message.received",
        event_id: "evt_123",
        message: {
          from: [{ email: "jane@example.com" }],
          subject: "Need help",
          timestamp: "2026-03-11T10:00:00Z",
        },
      },
    });

    expect(normalized).toEqual([]);
  });
});
