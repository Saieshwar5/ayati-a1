import { describe, expect, it, vi } from "vitest";
import {
  getMessage,
  listMessages,
  replyMessage,
  sendMessage,
  status,
} from "../../../data/skills/nylas-mail/adapter.js";

function createContext(httpRequest = vi.fn()) {
  return {
    secrets: {
      resolve: vi.fn(async (ref: string) => {
        if (ref === "nylas.api_key") {
          return { ok: true, env: { NYLAS_API_KEY: "nylas-key" } };
        }
        if (ref === "nylas.grant_id") {
          return { ok: true, env: { NYLAS_GRANT_ID: "grant_123" } };
        }
        return { ok: false, error: `Unknown secret ${ref}` };
      }),
      inspect: vi.fn(),
    },
    command: {
      run: vi.fn(),
    },
    http: {
      request: httpRequest,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

describe("nylas-mail adapter", () => {
  it("checks grant status through the Nylas grant endpoint", async () => {
    const ctx = createContext(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify({
        data: {
          id: "grant_123",
          email: "agent@example.com",
          provider: "google",
          scope: ["email.read_only", "email.send"],
        },
      }),
    }));

    const result = await status(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.http.request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://api.us.nylas.com/v3/grants/grant_123",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer nylas-key",
      },
      timeoutMs: 30000,
    });

    expect(JSON.parse(result.output ?? "{}")).toEqual(expect.objectContaining({
      ok: true,
      grantId: "grant_123",
      email: "agent@example.com",
      provider: "google",
    }));
  });

  it("lists and normalizes messages with provider-native search and pagination", async () => {
    const ctx = createContext(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify({
        next_cursor: "cursor_2",
        data: [
          {
            id: "msg_123",
            thread_id: "thread_123",
            subject: "Quarterly update",
            from: [{ email: "boss@example.com", name: "Boss" }],
            to: [{ email: "agent@example.com" }],
            unread: true,
            body: "<p>Hello <strong>team</strong></p>",
            snippet: "Hello team",
            attachments: [{ id: "att_1" }],
            date: 1710000000,
          },
        ],
      }),
    }));

    const result = await listMessages(ctx, {
      input: {
        limit: 5,
        unread: true,
        pageToken: "cursor_1",
        searchQueryNative: "subject:quarterly",
      },
    });

    expect(result.ok).toBe(true);
    expect(ctx.http.request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://api.us.nylas.com/v3/grants/grant_123/messages?limit=5&unread=true&page_token=cursor_1&search_query_native=subject%3Aquarterly",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer nylas-key",
      },
      timeoutMs: 30000,
    });

    expect(JSON.parse(result.output ?? "{}")).toEqual({
      grantId: "grant_123",
      nextCursor: "cursor_2",
      messages: [
        {
          id: "msg_123",
          threadId: "thread_123",
          subject: "Quarterly update",
          sentAt: "2024-03-09T16:00:00.000Z",
          receivedAt: "2024-03-09T16:00:00.000Z",
          from: [{ email: "boss@example.com", name: "Boss" }],
          to: [{ email: "agent@example.com" }],
          unread: true,
          hasAttachments: true,
          attachmentCount: 1,
          snippet: "Hello team",
          bodyPreview: "Hello team",
        },
      ],
    });
  });

  it("fetches one normalized message by id", async () => {
    const ctx = createContext(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify({
        data: {
          id: "msg_555",
          subject: "Need approval",
          from: [{ email: "user@example.com" }],
          body: "Please approve.",
          date: 1710000300,
        },
      }),
    }));

    const result = await getMessage(ctx, {
      input: {
        messageId: "msg_555",
      },
    });

    expect(result.ok).toBe(true);
    expect(ctx.http.request).toHaveBeenCalledWith({
      method: "GET",
      url: "https://api.us.nylas.com/v3/grants/grant_123/messages/msg_555",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer nylas-key",
      },
      timeoutMs: 30000,
    });
    expect(JSON.parse(result.output ?? "{}")).toEqual({
      grantId: "grant_123",
      message: {
        id: "msg_555",
        subject: "Need approval",
        sentAt: "2024-03-09T16:05:00.000Z",
        receivedAt: "2024-03-09T16:05:00.000Z",
        from: [{ email: "user@example.com" }],
        hasAttachments: false,
        attachmentCount: 0,
        bodyPreview: "Please approve.",
      },
    });
  });

  it("sends new messages through messages/send with the long send timeout", async () => {
    const ctx = createContext(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify({
        data: {
          id: "msg_sent",
          thread_id: "thread_new",
          subject: "Hello",
          from: [{ email: "agent@example.com" }],
          to: [{ email: "user@example.com" }],
          body: "Thanks for the update.",
        },
      }),
    }));

    const result = await sendMessage(ctx, {
      input: {
        to: ["user@example.com"],
        cc: ["manager@example.com"],
        subject: "Hello",
        body: "Thanks for the update.",
      },
    });

    expect(result.ok).toBe(true);
    expect(ctx.http.request).toHaveBeenCalledWith({
      method: "POST",
      url: "https://api.us.nylas.com/v3/grants/grant_123/messages/send",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer nylas-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: [{ email: "user@example.com" }],
        cc: [{ email: "manager@example.com" }],
        subject: "Hello",
        body: "Thanks for the update.",
      }),
      timeoutMs: 150000,
    });
    expect(JSON.parse(result.output ?? "{}")).toEqual(expect.objectContaining({
      grantId: "grant_123",
      message: expect.objectContaining({
        id: "msg_sent",
        threadId: "thread_new",
        subject: "Hello",
      }),
    }));
  });

  it("replies with reply_to_message_id through the send endpoint", async () => {
    const ctx = createContext(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: JSON.stringify({
        data: {
          id: "msg_reply",
          thread_id: "thread_123",
          subject: "Re: Need help",
          from: [{ email: "agent@example.com" }],
          body: "Here is the answer.",
        },
      }),
    }));

    const result = await replyMessage(ctx, {
      input: {
        messageId: "msg_123",
        body: "Here is the answer.",
      },
    });

    expect(result.ok).toBe(true);
    expect(ctx.http.request).toHaveBeenCalledWith({
      method: "POST",
      url: "https://api.us.nylas.com/v3/grants/grant_123/messages/send",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer nylas-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reply_to_message_id: "msg_123",
        body: "Here is the answer.",
      }),
      timeoutMs: 150000,
    });
    expect(JSON.parse(result.output ?? "{}")).toEqual(expect.objectContaining({
      grantId: "grant_123",
      replyToMessageId: "msg_123",
    }));
  });
});
