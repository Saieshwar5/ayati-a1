import type { PluginSystemEventInput } from "../core/contracts/plugin.js";

export type PulseItemKind = "event" | "reminder" | "notification" | "task";
export type PulseItemStatus = "active" | "paused" | "completed" | "cancelled";
export type PulseExecutionMode = "none" | "notify" | "run_task";
export type PulseOccurrenceStatus = "queued" | "leased" | "completed" | "failed" | "skipped" | "dead_lettered";
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

export interface PulseDailySchedule {
  kind: "daily";
  hour: number;
  minute: number;
  expression?: string;
}

export interface PulseWeeklySchedule {
  kind: "weekly";
  weekday?: PulseWeekday;
  weekdays?: PulseWeekday[];
  hour: number;
  minute: number;
  expression?: string;
}

export interface PulseMonthlySchedule {
  kind: "monthly";
  day: number;
  hour: number;
  minute: number;
  expression?: string;
}

export interface PulseYearlySchedule {
  kind: "yearly";
  month: number;
  day: number;
  hour: number;
  minute: number;
  expression?: string;
}

export type PulseSchedule =
  | PulseOnceSchedule
  | PulseIntervalSchedule
  | PulseDailySchedule
  | PulseWeeklySchedule
  | PulseMonthlySchedule
  | PulseYearlySchedule;

export interface PulseTaskSpec {
  objective: string;
  requestedAction?: string;
  inputs?: Record<string, unknown>;
  constraints?: string[];
  successCriteria?: string[];
  context?: Record<string, unknown>;
}

export interface PulseItemPayload {
  task?: PulseTaskSpec;
  requestedAction?: string;
  priority?: string | number;
  tags?: string[];
  originRunId?: string;
  originSessionId?: string;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
  };
  catchUpMode?: "latest_only";
  concurrencyMode?: "single_flight";
  [key: string]: unknown;
}

export interface PulseItem {
  id: string;
  clientId: string;
  source: "pulse";
  kind: PulseItemKind;
  status: PulseItemStatus;
  executionMode: PulseExecutionMode;
  title: string;
  instruction: string;
  timezone: string;
  schedule: PulseSchedule | null;
  payload: PulseItemPayload;
  metadata: Record<string, unknown>;
  startAtUtc: string | null;
  endAtUtc: string | null;
  durationMs: number | null;
  allDay: boolean;
  nextDueAt: string | null;
  lastDueAt: string | null;
  lastCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PulseOccurrence {
  id: string;
  itemId: string;
  scheduledFor: string;
  status: PulseOccurrenceStatus;
  attemptCount: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  availableAt: string;
  eventId: string | null;
  runId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PulseLeasedOccurrence {
  item: PulseItem;
  occurrence: PulseOccurrence;
}

export interface PulseItemHistoryEntry {
  id: number;
  itemId: string;
  clientId: string;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface PulsePreviewOccurrence {
  index: number;
  scheduledForUtc: string;
  timezone: string;
  localDate: string;
  localTime: string;
  weekday: string;
}

export interface PulseNowSnapshot {
  nowUtc: string;
  timezone: string;
  localDate: string;
  localTime: string;
  weekday: string;
}

export interface PulseClockHealth extends PulseNowSnapshot {
  epochMs: number;
  monotonicMs: number;
  systemTimeZone: string;
  offsetMinutes: number;
  syncHealthy: boolean | null;
  diagnostics: Record<string, unknown>;
}

export interface PulseCreateItemInput {
  clientId: string;
  kind: PulseItemKind;
  executionMode?: PulseExecutionMode;
  title: string;
  instruction: string;
  timezone: string;
  schedule?: PulseSchedule | null;
  payload?: PulseItemPayload;
  metadata?: Record<string, unknown>;
  startAtUtc?: string | null;
  endAtUtc?: string | null;
  durationMs?: number | null;
  allDay?: boolean;
  nextDueAt?: string | null;
}

export interface PulseUpdateItemInput {
  title?: string;
  instruction?: string;
  timezone?: string;
  schedule?: PulseSchedule | null;
  payload?: PulseItemPayload;
  metadata?: Record<string, unknown>;
  startAtUtc?: string | null;
  endAtUtc?: string | null;
  durationMs?: number | null;
  allDay?: boolean;
  nextDueAt?: string | null;
}

export interface PulseListItemsOptions {
  clientId: string;
  status?: PulseItemStatus | "all";
  kind?: PulseItemKind | "all";
  limit?: number;
}

export interface PulsePreviewOptions {
  itemId?: string;
  schedule?: PulseSchedule | null;
  timezone?: string;
  startAtUtc?: string | null;
  count?: number;
}

export interface PulseDueOccurrenceLeaseOptions {
  clientId: string;
  leaseOwner: string;
  leaseMs: number;
  now?: Date;
  limit?: number;
}

export interface PulseOccurrenceDispatchFailureInput {
  occurrenceId: string;
  errorMessage: string;
  now?: Date;
}

export interface PulseOccurrenceDispatchSuccessInput {
  occurrenceId: string;
  eventId: string;
  now?: Date;
}

export interface PulseOccurrenceDismissInput {
  clientId: string;
  itemId: string;
  occurrenceId?: string;
  now?: Date;
}

export interface PulseReminderDueEvent extends PluginSystemEventInput {}

export type PulseReminderStatus = Extract<PulseItemStatus, "active" | "completed" | "cancelled">;
export type PulseScheduledItemIntentKind = "reminder" | "task";
export type PulseReminderSchedule = PulseSchedule;

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
