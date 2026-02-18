import { describe, expect, it } from "vitest";
import { InMemorySession } from "../../src/memory/session.js";
import type { UserMessageEvent, AssistantMessageEvent, ToolCallEvent, ToolResultEvent, AgentStepEvent } from "../../src/memory/session-events.js";

describe("InMemorySession", () => {
  it("tracks conversation turns", () => {
    const session = new InMemorySession(
      "s1",
      "c1",
      "2026-02-08T00:00:00.000Z",
      "sessions/2026-02-08/s1.md",
    );

    const userEvent: UserMessageEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "user_message",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      content: "hello",
    };

    const assistantEvent: AssistantMessageEvent = {
      v: 2,
      ts: "2026-02-08T00:01:05.000Z",
      type: "assistant_message",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      content: "hi there",
    };

    session.addEntry(userEvent);
    session.addEntry(assistantEvent);

    const turns = session.getConversationTurns();
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.content).toBe("hello");
    expect(turns[0]?.sessionPath).toBe("sessions/2026-02-08/s1.md");
    expect(turns[1]?.role).toBe("assistant");
    expect(turns[1]?.content).toBe("hi there");
  });

  it("tracks user turn count", () => {
    const session = new InMemorySession(
      "s1",
      "c1",
      "2026-02-08T00:00:00.000Z",
      "sessions/2026-02-08/s1.md",
    );

    session.addEntry({
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "user_message",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      content: "msg1",
    });

    session.addEntry({
      v: 2,
      ts: "2026-02-08T00:02:00.000Z",
      type: "user_message",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      content: "msg2",
    });

    expect(session.userTurnCount).toBe(2);
  });

  it("records both tool_call and tool_result as tool events", () => {
    const session = new InMemorySession(
      "s1",
      "c1",
      "2026-02-08T00:00:00.000Z",
      "sessions/2026-02-08/s1.md",
    );

    const callEvent: ToolCallEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "tool_call",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      args: { cmd: "pwd" },
    };

    const resultEvent: ToolResultEvent = {
      v: 2,
      ts: "2026-02-08T00:01:01.000Z",
      type: "tool_result",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
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
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]?.eventType).toBe("tool_call");
    expect(toolEvents[1]?.eventType).toBe("tool_result");
    expect(toolEvents[1]?.toolName).toBe("shell");
    expect(toolEvents[1]?.status).toBe("success");
    expect(toolEvents[1]?.args).toContain("pwd");
  });

  it("estimates tool event tokens from full args and output", () => {
    const session = new InMemorySession(
      "s1",
      "c1",
      "2026-02-08T00:00:00.000Z",
      "sessions/2026-02-08/s1.md",
    );

    const callEvent: ToolCallEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "tool_call",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      args: { cmd: "echo hello world" },
    };

    const resultEvent: ToolResultEvent = {
      v: 2,
      ts: "2026-02-08T00:01:01.000Z",
      type: "tool_result",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
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
    const session = new InMemorySession(
      "s1",
      "c1",
      "2026-02-08T00:00:00.000Z",
      "sessions/2026-02-08/s1.md",
    );
    expect(session.estimateToolEventTokens()).toBe(0);
  });

  it("returns agent step events mapped to prompt-ready type", () => {
    const session = new InMemorySession(
      "s1",
      "c1",
      "2026-02-08T00:00:00.000Z",
      "sessions/2026-02-08/s1.md",
    );

    const stepEvent: AgentStepEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "agent_step",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      step: 1,
      phase: "reason",
      summary: "Analyze user request",
      approachesTried: [],
    };

    const stepEvent2: AgentStepEvent = {
      v: 2,
      ts: "2026-02-08T00:01:05.000Z",
      type: "agent_step",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      step: 2,
      phase: "act",
      summary: "Create directory",
      approachesTried: ["mkdir"],
      actionToolName: "create_directory",
      endStatus: "success",
    };

    session.addEntry(stepEvent);
    session.addEntry(stepEvent2);

    const events = session.getAgentStepEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.phase).toBe("reason");
    expect(events[0]?.summary).toBe("Analyze user request");
    expect(events[0]?.actionToolName).toBeUndefined();
    expect(events[1]?.phase).toBe("act");
    expect(events[1]?.actionToolName).toBe("create_directory");
    expect(events[1]?.endStatus).toBe("success");
  });

  it("respects limit on getAgentStepEvents", () => {
    const session = new InMemorySession(
      "s1",
      "c1",
      "2026-02-08T00:00:00.000Z",
      "sessions/2026-02-08/s1.md",
    );

    for (let i = 1; i <= 5; i++) {
      session.addEntry({
        v: 2,
        ts: `2026-02-08T00:0${i}:00.000Z`,
        type: "agent_step",
        sessionId: "s1",
        sessionPath: "sessions/2026-02-08/s1.md",
        step: i,
        phase: "reason",
        summary: `Step ${i}`,
        approachesTried: [],
      });
    }

    const limited = session.getAgentStepEvents(2);
    expect(limited).toHaveLength(2);
    expect(limited[0]?.step).toBe(4);
    expect(limited[1]?.step).toBe(5);
  });

  it("returns raw agent step session events", () => {
    const session = new InMemorySession(
      "s1",
      "c1",
      "2026-02-08T00:00:00.000Z",
      "sessions/2026-02-08/s1.md",
    );

    session.addEntry({
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "agent_step",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      step: 1,
      phase: "reflect",
      summary: "Tool failed, adjusting approach",
      approachesTried: ["attempt1"],
    });

    const raw = session.getAgentStepSessionEvents();
    expect(raw).toHaveLength(1);
    expect(raw[0]?.type).toBe("agent_step");
    expect(raw[0]?.approachesTried).toEqual(["attempt1"]);
  });

  it("updates lastActivityAt on addEntry", () => {
    const session = new InMemorySession(
      "s1",
      "c1",
      "2026-02-08T00:00:00.000Z",
      "sessions/2026-02-08/s1.md",
    );
    expect(session.lastActivityAt).toBe("2026-02-08T00:00:00.000Z");

    session.addEntry({
      v: 2,
      ts: "2026-02-08T01:00:00.000Z",
      type: "user_message",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      content: "later",
    });

    expect(session.lastActivityAt).toBe("2026-02-08T01:00:00.000Z");
  });

});
