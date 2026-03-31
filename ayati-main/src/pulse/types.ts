import type { PluginSystemEventInput } from "../core/contracts/plugin.js";

export type PulseReminderStatus = "active" | "completed" | "cancelled";
export type PulseScheduledItemIntentKind = "reminder" | "task";
export type PulseDurationUnit = "minute" | "hour" | "day" | "week";

export type PulseWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface PulseOnceSchedule {
  kind: "once";
  at: string;
  expression?: string;
}

export interface PulseIntervalSchedule {
  kind: "interval";
  everyMs: number;
  value?: number;
  unit?: PulseDurationUnit;
  anchorAt: string;
  expression?: string;
}

export interface PulseTaskSpec {
  objective: string;
  requestedAction?: string;
  inputs?: Record<string, unknown>;
  constraints?: string[];
  successCriteria?: string[];
  context?: Record<string, unknown>;
}

export interface PulseDailySchedule {
  kind: "daily";
  hour: number;
  minute: number;
  expression?: string;
}

export interface PulseWeeklySchedule {
  kind: "weekly";
  weekday: PulseWeekday;
  hour: number;
  minute: number;
  expression?: string;
}

export type PulseReminderSchedule =
  | PulseOnceSchedule
  | PulseIntervalSchedule
  | PulseDailySchedule
  | PulseWeeklySchedule;

export interface PulseReminder {
  id: string;
  clientId: string;
  intentKind: PulseScheduledItemIntentKind;
  title: string;
  instruction: string;
  timezone: string;
  status: PulseReminderStatus;
  schedule: PulseReminderSchedule;
  nextTriggerAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt?: string;
  lastDeliveredOccurrenceId?: string;
  originRunId?: string;
  originSessionId?: string;
  requestedAction?: string;
  task?: PulseTaskSpec;
  metadata: Record<string, unknown>;
}

export interface PulseStoreDocument {
  version: 1;
  reminders: PulseReminder[];
}

export interface PulseReminderDueEvent extends PluginSystemEventInput {}

export interface PulseNowSnapshot {
  nowUtc: string;
  timezone: string;
  localDate: string;
  localTime: string;
  weekday: string;
}

export interface PulseCreateReminderInput {
  clientId: string;
  intentKind?: PulseScheduledItemIntentKind;
  title: string;
  instruction: string;
  timezone: string;
  schedule: PulseReminderSchedule;
  nextTriggerAt: string;
  metadata?: Record<string, unknown>;
  originRunId?: string;
  originSessionId?: string;
  requestedAction?: string;
  task?: PulseTaskSpec;
}

export interface PulseListRemindersOptions {
  clientId: string;
  status?: PulseReminderStatus | "all";
  limit?: number;
}

export interface PulseMarkDeliveredInput {
  clientId: string;
  reminderId: string;
  occurrenceId: string;
  scheduledFor: string;
  triggeredAt: string;
}
