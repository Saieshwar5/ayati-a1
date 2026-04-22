import { describe, expect, it } from "vitest";
import { normalizeSystemEvent } from "../../src/core/contracts/plugin.js";
import {
  classifySystemEvent,
  resolveSystemEventPolicy,
  resolveSystemEventResponseKind,
  type SystemEventPolicyConfig,
} from "../../src/ivec/system-event-policy.js";

describe("system-event-policy", () => {
  it("prefers explicit classification metadata when present", () => {
    const event = normalizeSystemEvent({
      source: "custom-system",
      eventName: "task.requested",
      summary: "Please send the report",
      intent: {
        kind: "task",
        eventClass: "task_requested",
        trustTier: "trusted_system",
        effectLevel: "act_external",
        requestedAction: "send_report",
        createdBy: "external",
      },
      payload: {},
    });

    expect(classifySystemEvent(event)).toEqual({
      intentKind: "task",
      eventClass: "task_requested",
      trustTier: "trusted_system",
      effectLevel: "act_external",
      requestedAction: "send_report",
      createdBy: "external",
    });
  });

  it("infers pulse reminders as internal trigger work created by the user", () => {
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
      eventClass: "trigger_fired",
      trustTier: "internal",
      effectLevel: "act",
      requestedAction: "check_system_health_now",
      createdBy: "user",
    });
  });

  it("infers inbound email as external observed work", () => {
    const event = normalizeSystemEvent({
      source: "agentmail",
      eventName: "message.received",
      summary: "Incoming email from jane@example.com with subject Need help",
      payload: {},
    });

    expect(classifySystemEvent(event)).toEqual({
      intentKind: "task",
      eventClass: "message_received",
      trustTier: "external",
      effectLevel: "observe",
      requestedAction: "review_incoming_message",
      createdBy: "external",
    });
  });

  it("resolves v2 policy rules by explicit event class", () => {
    const policy: SystemEventPolicyConfig = {
      schemaVersion: 2,
      defaults: {
        mode: "analyze_notify",
        delivery: "notification",
        contextVisibility: "summary",
        approvalRequired: false,
      },
      rules: [
        {
          source: "agentmail",
          eventClass: "message_received",
          mode: "analyze_ask",
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
    expect(resolveSystemEventPolicy(policy, event, classification)).toEqual({
      mode: "analyze_ask",
      delivery: "feedback",
      contextVisibility: "summary",
      approvalRequired: false,
    });
    expect(resolveSystemEventResponseKind(policy, event)).toBe("feedback");
  });

  it("prefers source plus event plus requestedAction rules over broader matches", () => {
    const policy: SystemEventPolicyConfig = {
      schemaVersion: 2,
      defaults: {
        mode: "analyze_notify",
        delivery: "notification",
        contextVisibility: "summary",
        approvalRequired: false,
      },
      rules: [
        {
          source: "custom-system",
          eventClass: "task_requested",
          mode: "analyze_ask",
        },
        {
          source: "custom-system",
          eventName: "task.requested",
          requestedAction: "send_report",
          mode: "draft_then_approve",
        },
      ],
    };

    const event = normalizeSystemEvent({
      source: "custom-system",
      eventName: "task.requested",
      summary: "Please send the report",
      intent: {
        requestedAction: "send_report",
      },
      payload: {},
    });

    const classification = classifySystemEvent(event);
    expect(resolveSystemEventPolicy(policy, event, classification).mode).toBe("draft_then_approve");
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
