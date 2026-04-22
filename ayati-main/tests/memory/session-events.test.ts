import { describe, expect, it } from "vitest";
import { serializeEvent, deserializeEvent, isAgentStepEvent } from "../../src/memory/session-events.js";
import type {
  SessionOpenEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolResultEvent,
  AgentStepEvent,
  TaskSummaryEvent,
  FeedbackOpenedEvent,
  SystemEventReceivedEvent,
} from "../../src/memory/session-events.js";

describe("session-events", () => {
  it("serializes and deserializes a session_open event", () => {
    const event: SessionOpenEvent = {
      v: 2,
      ts: "2026-02-08T00:00:00.000Z",
      type: "session_open",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      clientId: "local",
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line);

    expect(parsed.type).toBe("session_open");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.v).toBe(2);
    expect(parsed.sessionPath).toBe("sessions/2026-02-08/s1.md");
  });

  it("serializes and deserializes a user_message event", () => {
    const event: UserMessageEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "user_message",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      content: "find learn1.go",
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line) as UserMessageEvent;

    expect(parsed.type).toBe("user_message");
    expect(parsed.content).toBe("find learn1.go");
    expect(parsed.sessionPath).toBe("sessions/2026-02-08/s1.md");
  });

  it("serializes and deserializes an assistant_message event with response kind", () => {
    const event: AssistantMessageEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "assistant_message",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      content: "Should I send the draft?",
      responseKind: "feedback",
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line) as AssistantMessageEvent;

    expect(parsed.type).toBe("assistant_message");
    expect(parsed.content).toBe("Should I send the draft?");
    expect(parsed.responseKind).toBe("feedback");
  });

  it("serializes and deserializes a tool_result event", () => {
    const event: ToolResultEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "tool_result",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
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
    expect(parsed.sessionPath).toBe("sessions/2026-02-08/s1.md");
  });

  it("serializes and deserializes a task_summary event", () => {
    const event: TaskSummaryEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "task_summary",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      runId: "r1",
      runPath: "data/runs/r1",
      status: "completed",
      summary: "Task finished",
      assistantResponseKind: "feedback",
      feedbackLabel: "Send draft",
      entityHints: ["draft"],
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line) as TaskSummaryEvent;

    expect(parsed.type).toBe("task_summary");
    expect(parsed.runId).toBe("r1");
    expect(parsed.runPath).toBe("data/runs/r1");
    expect(parsed.assistantResponseKind).toBe("feedback");
    expect(parsed.feedbackLabel).toBe("Send draft");
  });

  it("isAgentStepEvent returns true for agent_step events", () => {
    const event: AgentStepEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "agent_step",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      step: 1,
      phase: "reason",
      summary: "Analyzing request",
      approachesTried: [],
    };

    expect(isAgentStepEvent(event)).toBe(true);
  });

  it("isAgentStepEvent returns false for non agent_step events", () => {
    const event: UserMessageEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "user_message",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      content: "hello",
    };

    expect(isAgentStepEvent(event)).toBe(false);
  });

  it("serializes and deserializes system_event_received", () => {
    const event: SystemEventReceivedEvent = {
      v: 2,
      ts: "2026-02-08T00:01:00.000Z",
      type: "system_event_received",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      runId: "r1",
      source: "pulse",
      event: "reminder_due",
      eventId: "evt-1",
      occurrenceId: "occ-1",
      reminderId: "rem-1",
      instruction: "check health",
      scheduledFor: "2026-02-08T00:00:00.000Z",
      triggeredAt: "2026-02-08T00:01:00.000Z",
      payload: { foo: "bar" },
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line) as SystemEventReceivedEvent;

    expect(parsed.type).toBe("system_event_received");
    expect(parsed.source).toBe("pulse");
    expect(parsed.eventId).toBe("evt-1");
    expect(parsed.payload?.["foo"]).toBe("bar");
  });

  it("serializes and deserializes feedback_opened", () => {
    const event: FeedbackOpenedEvent = {
      v: 2,
      ts: "2026-02-08T00:02:00.000Z",
      type: "feedback_opened",
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      runId: "r1",
      feedbackId: "fb-1",
      kind: "approval",
      shortLabel: "send Arun email",
      message: "Should I send the draft?",
      actionType: "send_email",
      sourceEventId: "evt-1",
      entityHints: ["Arun", "email"],
      payloadSummary: "Draft ready",
      expiresAt: "2026-02-09T00:02:00.000Z",
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line) as FeedbackOpenedEvent;

    expect(parsed.type).toBe("feedback_opened");
    expect(parsed.feedbackId).toBe("fb-1");
    expect(parsed.kind).toBe("approval");
    expect(parsed.payloadSummary).toBe("Draft ready");
    expect(parsed.expiresAt).toBe("2026-02-09T00:02:00.000Z");
  });

  it("serializes and deserializes feedback_resolved with outcome", () => {
    const event = {
      v: 2,
      ts: "2026-02-08T00:03:00.000Z",
      type: "feedback_resolved" as const,
      sessionId: "s1",
      sessionPath: "sessions/2026-02-08/s1.md",
      runId: "r1",
      feedbackId: "fb-1",
      resolution: "expired" as const,
    };

    const line = serializeEvent(event);
    const parsed = deserializeEvent(line);

    expect(parsed.type).toBe("feedback_resolved");
    if (parsed.type !== "feedback_resolved") {
      throw new Error("unexpected event type");
    }
    expect(parsed.feedbackId).toBe("fb-1");
    expect(parsed.resolution).toBe("expired");
  });

  it("throws on unsupported version", () => {
    const badLine = JSON.stringify({ v: 99, ts: "t", type: "user_message", sessionId: "s" });
    expect(() => deserializeEvent(badLine)).toThrow("Unsupported event version");
  });

  it("throws on invalid JSON", () => {
    expect(() => deserializeEvent("not json")).toThrow();
  });
});
