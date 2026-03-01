export type PulseReminderStatus = "active" | "completed" | "cancelled";

export type PulseWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface PulseOnceSchedule {
  kind: "once";
  at: string;
  expression?: string;
}

export interface PulseIntervalSchedule {
  kind: "interval";
  everyMs: number;
  anchorAt: string;
  expression?: string;
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
  metadata: Record<string, unknown>;
}

export interface PulseStoreDocument {
  version: 1;
  reminders: PulseReminder[];
}

export interface PulseReminderDueEvent {
  type: "system_event";
  source: "pulse";
  event: "reminder_due";
  eventId: string;
  occurrenceId: string;
  reminderId: string;
  title: string;
  instruction: string;
  scheduledFor: string;
  triggeredAt: string;
  timezone: string;
  metadata: Record<string, unknown>;
  originRunId?: string;
  originSessionId?: string;
}

export interface PulseNowSnapshot {
  nowUtc: string;
  timezone: string;
  localDate: string;
  localTime: string;
  weekday: string;
}

export interface PulseCreateReminderInput {
  clientId: string;
  title: string;
  instruction: string;
  timezone: string;
  schedule: PulseReminderSchedule;
  nextTriggerAt: string;
  metadata?: Record<string, unknown>;
  originRunId?: string;
  originSessionId?: string;
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
