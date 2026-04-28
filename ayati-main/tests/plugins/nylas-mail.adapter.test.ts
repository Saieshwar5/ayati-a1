import { describe, expect, it, vi } from "vitest";
import { NylasMailAdapter } from "../../src/plugins/nylas-mail/adapter.js";

describe("NylasMailAdapter", () => {
  it("normalizes supported webhook payloads into canonical system events", async () => {
    const adapter = new NylasMailAdapter({
      grantId: "grant_123",
      getGrantProfile: () => ({
        email: "agent@example.com",
        provider: "google",
      }),
    });

    const normalized = await adapter.normalize({
      source: "nylas-mail",
      clientId: "local",
      body: JSON.stringify({
        deltas: [{
          id: "evt_123",
          type: "message.created",
          object: "message",
          object_data: {
            id: "msg_123",
            grant_id: "grant_123",
            thread_id: "thread_123",
            subject: "Need help",
            from: [{ email: "jane@example.com" }],
            body: "Please check this request.",
            date: 1710000000,
          },
        }],
      }),
      payload: {
        deltas: [{
          id: "evt_123",
          type: "message.created",
          object: "message",
          object_data: {
            id: "msg_123",
            grant_id: "grant_123",
            thread_id: "thread_123",
            subject: "Need help",
            from: [{ email: "jane@example.com" }],
            body: "Please check this request.",
            date: 1710000000,
          },
        }],
      },
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toEqual(expect.objectContaining({
      source: "nylas-mail",
      eventName: "message.created",
      eventId: "evt_123",
      summary: "Incoming email from jane@example.com with subject Need help",
    }));
  });

  it("filters notifications for the wrong configured grant", async () => {
    const adapter = new NylasMailAdapter({
      grantId: "grant_123",
    });

    const normalized = await adapter.normalize({
      source: "nylas-mail",
      clientId: "local",
      body: JSON.stringify({
        deltas: [{
          id: "evt_123",
          type: "message.created",
          object_data: {
            id: "msg_123",
            grant_id: "grant_other",
            from: [{ email: "jane@example.com" }],
            subject: "Need help",
          },
        }],
      }),
      payload: {
        deltas: [{
          id: "evt_123",
          type: "message.created",
          object_data: {
            id: "msg_123",
            grant_id: "grant_other",
            from: [{ email: "jane@example.com" }],
            subject: "Need help",
          },
        }],
      },
    });

    expect(normalized).toEqual([]);
  });

  it("hydrates truncated notifications and ignores self-sent messages", async () => {
    const fetchMessage = vi.fn().mockResolvedValue({
      id: "msg_123",
      grant_id: "grant_123",
      thread_id: "thread_123",
      subject: "Re: hello",
      from: [{ email: "agent@example.com" }],
      body: "This was sent by the mailbox itself.",
      date: 1710000000,
    });

    const adapter = new NylasMailAdapter({
      grantId: "grant_123",
      getGrantProfile: () => ({
        email: "agent@example.com",
        provider: "google",
      }),
      fetchMessage,
    });

    const normalized = await adapter.normalize({
      source: "nylas-mail",
      clientId: "local",
      body: JSON.stringify({
        deltas: [{
          id: "evt_123",
          type: "message.created.truncated",
          object_data: {
            id: "msg_123",
            grant_id: "grant_123",
          },
        }],
      }),
      payload: {
        deltas: [{
          id: "evt_123",
          type: "message.created.truncated",
          object_data: {
            id: "msg_123",
            grant_id: "grant_123",
          },
        }],
      },
    });

    expect(fetchMessage).toHaveBeenCalledWith("grant_123", "msg_123");
    expect(normalized).toEqual([]);
  });
});
