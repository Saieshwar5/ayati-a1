import { describe, expect, it } from "vitest";
import { InMemorySession } from "../../src/memory/session.js";
import type { UserMessageEvent, AssistantMessageEvent, ToolCallEvent, ToolResultEvent } from "../../src/memory/session-events.js";

describe("InMemorySession", () => {
  it("tracks conversation turns", () => {
    const session = new InMemorySession("s1", "c1", "2026-02-08T00:00:00.000Z");

    const userEvent: UserMessageEvent = {
      v: 1,
      ts: "2026-02-08T00:01:00.000Z",
      type: "user_message",
      sessionId: "s1",
      runId: "r1",
      content: "hello",
    };

    const assistantEvent: AssistantMessageEvent = {
      v: 1,
      ts: "2026-02-08T00:01:05.000Z",
      type: "assistant_message",
      sessionId: "s1",
      runId: "r1",
      content: "hi there",
    };

    session.addEntry(userEvent);
    session.addEntry(assistantEvent);

    const turns = session.getConversationTurns();
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.content).toBe("hello");
    expect(turns[1]?.role).toBe("assistant");
    expect(turns[1]?.content).toBe("hi there");
  });

  it("tracks user turn count", () => {
    const session = new InMemorySession("s1", "c1", "2026-02-08T00:00:00.000Z");

    session.addEntry({
      v: 1,
      ts: "2026-02-08T00:01:00.000Z",
      type: "user_message",
      sessionId: "s1",
      runId: "r1",
      content: "msg1",
    });

    session.addEntry({
      v: 1,
      ts: "2026-02-08T00:02:00.000Z",
      type: "user_message",
      sessionId: "s1",
      runId: "r2",
      content: "msg2",
    });

    expect(session.userTurnCount).toBe(2);
  });

  it("returns tool events from tool_result entries", () => {
    const session = new InMemorySession("s1", "c1", "2026-02-08T00:00:00.000Z");

    const callEvent: ToolCallEvent = {
      v: 1,
      ts: "2026-02-08T00:01:00.000Z",
      type: "tool_call",
      sessionId: "s1",
      runId: "r1",
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      args: { cmd: "pwd" },
    };

    const resultEvent: ToolResultEvent = {
      v: 1,
      ts: "2026-02-08T00:01:01.000Z",
      type: "tool_result",
      sessionId: "s1",
      runId: "r1",
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      status: "success",
      output: "/home/user",
      durationMs: 15,
    };

    session.addEntry(callEvent);
    session.addEntry(resultEvent);

    const toolEvents = session.getToolEvents();
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.toolName).toBe("shell");
    expect(toolEvents[0]?.status).toBe("success");
    expect(toolEvents[0]?.argsPreview).toContain("pwd");
  });

  it("estimates tool event tokens from args and output previews", () => {
    const session = new InMemorySession("s1", "c1", "2026-02-08T00:00:00.000Z");

    const callEvent: ToolCallEvent = {
      v: 1,
      ts: "2026-02-08T00:01:00.000Z",
      type: "tool_call",
      sessionId: "s1",
      runId: "r1",
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      args: { cmd: "echo hello world" },
    };

    const resultEvent: ToolResultEvent = {
      v: 1,
      ts: "2026-02-08T00:01:01.000Z",
      type: "tool_result",
      sessionId: "s1",
      runId: "r1",
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      status: "success",
      output: "hello world",
      durationMs: 15,
    };

    session.addEntry(callEvent);
    session.addEntry(resultEvent);

    const tokens = session.estimateToolEventTokens();
    expect(tokens).toBeGreaterThan(0);
  });

  it("returns zero tool event tokens when no tool results exist", () => {
    const session = new InMemorySession("s1", "c1", "2026-02-08T00:00:00.000Z");
    expect(session.estimateToolEventTokens()).toBe(0);
  });

  it("updates lastActivityAt on addEntry", () => {
    const session = new InMemorySession("s1", "c1", "2026-02-08T00:00:00.000Z");
    expect(session.lastActivityAt).toBe("2026-02-08T00:00:00.000Z");

    session.addEntry({
      v: 1,
      ts: "2026-02-08T01:00:00.000Z",
      type: "user_message",
      sessionId: "s1",
      runId: "r1",
      content: "later",
    });

    expect(session.lastActivityAt).toBe("2026-02-08T01:00:00.000Z");
  });

});
