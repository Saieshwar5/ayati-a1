import { describe, expect, it } from "vitest";
import { normalizeSystemEvent } from "../../src/core/contracts/plugin.js";
import {
  classifySystemEvent,
  resolveSystemEventPolicy,
  resolveSystemEventResponseKind,
  type SystemEventPolicyConfig,
} from "../../src/ivec/system-event-policy.js";

describe("system-event-policy", () => {
  it("prefers explicit intent metadata when present", () => {
    const event = normalizeSystemEvent({
      source: "custom-system",
      eventName: "task.requested",
      summary: "Please send the report",
      intent: {
        kind: "task",
        requestedAction: "send_report",
        createdBy: "external",
      },
      payload: {},
    });

    expect(classifySystemEvent(event)).toEqual({
      intentKind: "task",
      requestedAction: "send_report",
      createdBy: "external",
    });
  });

  it("infers pulse reminders as user-created reminder work", () => {
    const event = normalizeSystemEvent({
      source: "pulse",
      eventName: "reminder_due",
      summary: "Reminder due: Health",
      payload: {
        reminderId: "rem-1",
        instruction: "Check system health now",
      },
    });

    expect(classifySystemEvent(event)).toEqual({
      intentKind: "reminder",
      requestedAction: "check_system_health_now",
      createdBy: "user",
    });
  });

  it("infers pulse scheduled tasks as user-created task work", () => {
    const event = normalizeSystemEvent({
      source: "pulse",
      eventName: "task_due",
      summary: "Scheduled task due: Health",
      payload: {
        taskId: "task-1",
        instruction: "Check system health",
        requestedAction: "check_system_health",
      },
    });

    expect(classifySystemEvent(event)).toEqual({
      intentKind: "task",
      requestedAction: "check_system_health",
      createdBy: "user",
    });
  });

  it("resolves handling mode from modern policy rules", () => {
    const policy: SystemEventPolicyConfig = {
      schemaVersion: 1,
      defaults: {
        mode: "analyze_notify",
        delivery: "notification",
        contextVisibility: "summary",
        approvalRequired: false,
        feedbackTtlHours: 24,
      },
      rules: [
        {
          source: "agentmail",
          eventName: "message.received",
          intentKind: "task",
          mode: "draft_then_approve",
          delivery: "feedback",
          contextVisibility: "summary",
          approvalRequired: true,
          feedbackTtlHours: 24,
        },
      ],
    };

    const event = normalizeSystemEvent({
      source: "agentmail",
      eventName: "message.received",
      summary: "Incoming email from jane@example.com with subject Need help",
      payload: {},
    });

    const classification = classifySystemEvent(event);
    expect(resolveSystemEventPolicy(policy, event, classification.intentKind)).toEqual({
      mode: "draft_then_approve",
      delivery: "feedback",
      contextVisibility: "summary",
      approvalRequired: true,
      feedbackTtlHours: 24,
    });
    expect(resolveSystemEventResponseKind(policy, event)).toBe("feedback");
  });

  it("resolves pulse scheduled tasks to auto-execute notification delivery", () => {
    const policy: SystemEventPolicyConfig = {
      schemaVersion: 1,
      defaults: {
        mode: "analyze_notify",
        delivery: "notification",
        contextVisibility: "summary",
        approvalRequired: false,
        feedbackTtlHours: 24,
      },
      rules: [
        {
          source: "pulse",
          eventName: "task_due",
          intentKind: "task",
          mode: "auto_execute_notify",
          delivery: "notification",
          contextVisibility: "summary",
          approvalRequired: false,
        },
      ],
    };

    const event = normalizeSystemEvent({
      source: "pulse",
      eventName: "task_due",
      summary: "Scheduled task due: Health",
      payload: {
        taskId: "task-1",
        instruction: "Check system health",
        requestedAction: "check_system_health",
      },
    });

    const classification = classifySystemEvent(event);
    expect(resolveSystemEventPolicy(policy, event, classification.intentKind)).toEqual({
      mode: "auto_execute_notify",
      delivery: "notification",
      contextVisibility: "summary",
      approvalRequired: false,
      feedbackTtlHours: 24,
    });
  });

  it("keeps legacy response-kind configs working", () => {
    const legacyPolicy = {
      defaultResponseKind: "notification",
      rules: [
        {
          source: "gmail-cli",
          eventName: "new_messages",
          defaultResponseKind: "feedback",
        },
      ],
    } as unknown as SystemEventPolicyConfig;

    const event = normalizeSystemEvent({
      source: "gmail-cli",
      eventName: "new_messages",
      summary: "3 new emails from work",
      payload: {
        unreadCount: 3,
      },
    });

    expect(resolveSystemEventResponseKind(legacyPolicy, event)).toBe("feedback");
  });
});
