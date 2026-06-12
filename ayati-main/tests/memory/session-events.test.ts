import { describe, expect, it } from "vitest";
import { deserializeEvent, serializeEvent } from "../../src/memory/session-events.js";

describe("session-events", () => {
  it("round-trips the simple daily session events", () => {
    const events = [
      {
        v: 1 as const,
        ts: "2026-06-12T09:00:00.000Z",
        type: "session_open" as const,
        sessionId: "s1",
        sessionPath: "sessions/2026-06-12/s1.jsonl",
        sessionDate: "2026-06-12",
        clientId: "local",
      },
      {
        v: 1 as const,
        ts: "2026-06-12T09:00:01.000Z",
        type: "user_message" as const,
        sessionId: "s1",
        sessionPath: "sessions/2026-06-12/s1.jsonl",
        sessionDate: "2026-06-12",
        runId: "r1",
        content: "hello",
      },
      {
        v: 1 as const,
        ts: "2026-06-12T09:00:02.000Z",
        type: "assistant_response" as const,
        sessionId: "s1",
        sessionPath: "sessions/2026-06-12/s1.jsonl",
        sessionDate: "2026-06-12",
        runId: "r1",
        content: "hi",
        responseKind: "reply" as const,
      },
      {
        v: 1 as const,
        ts: "2026-06-12T09:00:03.000Z",
        type: "system_event" as const,
        sessionId: "s1",
        sessionPath: "sessions/2026-06-12/s1.jsonl",
        sessionDate: "2026-06-12",
        runId: "r2",
        source: "pulse",
        event: "reminder_due",
        eventId: "evt-1",
        summary: "Reminder due: standup",
      },
    ];

    for (const event of events) {
      expect(deserializeEvent(serializeEvent(event))).toEqual(event);
    }
  });

  it("rejects unsupported event versions", () => {
    expect(() => deserializeEvent(JSON.stringify({ v: 2, type: "user_message" }))).toThrow(
      /Unsupported session event version/,
    );
  });
});
