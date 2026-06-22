import { describe, expect, it } from "vitest";
import {
  extractEpisodicEpisodes,
  parseSessionEventsFromContent,
} from "../../src/memory/episodic/session-extractor.js";
import type { SessionEvent } from "../../src/memory/session-events.js";

describe("episodic memory session extractor", () => {
  it("extracts conversation and session-summary episodes from simple daily session events", () => {
    const events: SessionEvent[] = [
      {
        v: 1,
        ts: "2026-06-12T09:00:00.000Z",
        type: "session_open",
        sessionId: "s1",
        sessionPath: "sessions/2026-06-12/s1.jsonl",
        sessionDate: "2026-06-12",
        clientId: "local",
      },
      {
        v: 1,
        ts: "2026-06-12T09:00:01.000Z",
        type: "user_message",
        sessionId: "s1",
        sessionPath: "sessions/2026-06-12/s1.jsonl",
        sessionDate: "2026-06-12",
        content: "What did we decide?",
      },
      {
        v: 1,
        ts: "2026-06-12T09:00:02.000Z",
        type: "assistant_response",
        sessionId: "s1",
        sessionPath: "sessions/2026-06-12/s1.jsonl",
        sessionDate: "2026-06-12",
        workRunId: "r1",
        content: "We decided sessions are daily logs.",
        responseKind: "reply",
      },
      {
        v: 1,
        ts: "2026-06-12T09:00:03.000Z",
        type: "system_event",
        sessionId: "s1",
        sessionPath: "sessions/2026-06-12/s1.jsonl",
        sessionDate: "2026-06-12",
        source: "pulse",
        event: "reminder_due",
        eventId: "evt-1",
        summary: "Reminder due: standup",
      },
    ];

    const episodes = extractEpisodicEpisodes({
      clientId: "local",
      sessionId: "s1",
      sessionPath: "sessions/2026-06-12/s1.jsonl",
      sessionFilePath: "/tmp/s1.jsonl",
      reason: "daily_session",
    }, events);

    expect(episodes.map((episode) => episode.episodeType)).toEqual([
      "conversation_exchange",
      "session_summary",
    ]);
    expect(episodes[0]?.runId).toBe("r1");
    expect(episodes[0]?.sourceText).toContain("daily logs");
    expect(episodes[1]?.sourceText).toContain("Reminder due: standup");
  });

  it("parses JSONL session content", () => {
    const content = [
      JSON.stringify({
        v: 1,
        ts: "2026-06-12T09:00:00.000Z",
        type: "session_open",
        sessionId: "s1",
        sessionPath: "sessions/2026-06-12/s1.jsonl",
        sessionDate: "2026-06-12",
        clientId: "local",
      }),
      "not json",
    ].join("\n");

    expect(parseSessionEventsFromContent(content)).toHaveLength(1);
  });
});
