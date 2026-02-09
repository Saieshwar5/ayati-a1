import { describe, expect, it } from "vitest";
import { serializeEvent, deserializeEvent } from "../../src/memory/session-events.js";
import type { SessionOpenEvent, UserMessageEvent, ToolResultEvent } from "../../src/memory/session-events.js";

describe("session-events", () => {
  it("serializes and deserializes a session_open event", () => {
    const event: SessionOpenEvent = {
      v: 1,
      ts: "2026-02-08T00:00:00.000Z",
      type: "session_open",
      sessionId: "s1",
      clientId: "local",
      tier: "rare",
      hardCapMinutes: 1440,
      idleTimeoutMinutes: 180,
      previousSessionSummary: "",
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line);

    expect(parsed.type).toBe("session_open");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.v).toBe(1);
  });

  it("serializes and deserializes a user_message event", () => {
    const event: UserMessageEvent = {
      v: 1,
      ts: "2026-02-08T00:01:00.000Z",
      type: "user_message",
      sessionId: "s1",
      runId: "r1",
      content: "find learn1.go",
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line) as UserMessageEvent;

    expect(parsed.type).toBe("user_message");
    expect(parsed.content).toBe("find learn1.go");
    expect(parsed.runId).toBe("r1");
  });

  it("serializes and deserializes a tool_result event", () => {
    const event: ToolResultEvent = {
      v: 1,
      ts: "2026-02-08T00:01:00.000Z",
      type: "tool_result",
      sessionId: "s1",
      runId: "r1",
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      status: "success",
      output: "./learn1.go",
      durationMs: 22,
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line) as ToolResultEvent;

    expect(parsed.type).toBe("tool_result");
    expect(parsed.status).toBe("success");
    expect(parsed.durationMs).toBe(22);
  });

  it("throws on unsupported version", () => {
    const badLine = JSON.stringify({ v: 99, ts: "t", type: "user_message", sessionId: "s" });
    expect(() => deserializeEvent(badLine)).toThrow("Unsupported event version");
  });

  it("throws on invalid JSON", () => {
    expect(() => deserializeEvent("not json")).toThrow();
  });
});
