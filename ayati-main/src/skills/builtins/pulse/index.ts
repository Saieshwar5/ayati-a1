import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import {
  computeNextTriggerForSchedule,
  parsePulseExpression,
  parseSnoozeDuration,
  previewPulseOccurrences,
  pulseDurationToMillis,
  pulseIntervalMsToValueUnit,
} from "../../../pulse/parser.js";
import { PulseStore } from "../../../pulse/store.js";
import { resolveTimeZone } from "../../../pulse/time.js";
import type {
  PulseClockHealth,
  PulseDailySchedule,
  PulseDurationUnit,
  PulseItem,
  PulseItemKind,
  PulseItemPayload,
  PulseItemStatus,
  PulseMonthlySchedule,
  PulsePreviewOccurrence,
  PulseReminder,
  PulseSchedule,
  PulseScheduledItemIntentKind,
  PulseTaskSpec,
  PulseWeeklySchedule,
  PulseYearlySchedule,
} from "../../../pulse/types.js";

type PulseAction =
  | "create"
  | "list"
  | "get"
  | "update"
  | "pause"
  | "resume"
  | "cancel"
  | "delete"
  | "snooze"
  | "dismiss"
  | "preview"
  | "now"
  | "health";

const MAX_TITLE_CHARS = 160;
const MAX_INSTRUCTION_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 120_000;
const TASK_INTENT_PATTERN = /\b(check|review|browse|search|monitor|watch|scan|summarize|fetch|collect|send|create|update|run|execute|sync|verify|inspect|audit|analyze)\b/i;
const REMINDER_INTENT_PATTERN = /\b(remind|reminder|notify|notification|alert)\b/i;

interface CreateOrUpdateSeed {
  kind?: PulseItemKind;
  intentKind?: PulseScheduledItemIntentKind;
  title?: string;
  instruction?: string;
  message?: string;
  when?: string;
  every?: string;
  timezone?: string;
  metadata?: Record<string, unknown>;
  schedule?: Record<string, unknown>;
  startAt?: string;
  endAt?: string;
  durationMs?: number;
  allDay?: boolean;
  task?: unknown;
  requestedAction?: string;
  priority?: string | number;
  tags?: string[];
}

interface CreateInput extends CreateOrUpdateSeed {
  action: "create";
}

interface ListInput {
  action: "list";
  status?: PulseItemStatus | "all";
  kind?: PulseItemKind | "all";
  limit?: number;
}

interface GetInput {
  action: "get";
  id: string;
}

interface UpdateInput extends CreateOrUpdateSeed {
  action: "update";
  id: string;
}

interface PauseInput {
  action: "pause";
  id: string;
}

interface ResumeInput {
  action: "resume";
  id: string;
}

interface CancelInput {
  action: "cancel";
  id: string;
}

interface DeleteInput {
  action: "delete";
  id: string;
}

interface SnoozeInput {
  action: "snooze";
  id: string;
  duration?: string;
  durationMs?: number;
}

interface DismissInput {
  action: "dismiss";
  id: string;
  occurrenceId?: string;
}

interface PreviewInput extends CreateOrUpdateSeed {
  action: "preview";
  id?: string;
  count?: number;
}

interface NowInput {
  action: "now";
  timezone?: string;
}

interface HealthInput {
  action: "health";
  timezone?: string;
}

type PulseInput =
  | CreateInput
  | ListInput
  | GetInput
  | UpdateInput
  | PauseInput
  | ResumeInput
  | CancelInput
  | DeleteInput
  | SnoozeInput
  | DismissInput
  | PreviewInput
  | NowInput
  | HealthInput;

function createStore(): PulseStore {
  return new PulseStore();
}

function fail(message: string): ToolResult {
  return { ok: false, error: `Invalid input: ${message}` };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResult(value: unknown): value is ToolResult {
  return isObject(value) && typeof value["ok"] === "boolean";
}

function parseAction(raw: unknown): PulseAction | null {
  if (
    raw === "create"
    || raw === "list"
    || raw === "get"
    || raw === "update"
    || raw === "pause"
    || raw === "resume"
    || raw === "cancel"
    || raw === "delete"
    || raw === "snooze"
    || raw === "dismiss"
    || raw === "preview"
    || raw === "now"
    || raw === "health"
  ) {
    return raw;
  }
  return null;
}

function normalizeRequestedAction(value: string): string | undefined {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return compact.length > 0 ? compact : undefined;
}

function parseStringArray(raw: unknown, fieldName: string): string[] | ToolResult | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return fail(`${fieldName} must be an array of strings.`);
  const values = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return values;
}

function parseTaskSpec(
  raw: unknown,
  fallbackObjective: string,
  fallbackRequestedAction?: string,
): PulseTaskSpec | ToolResult {
  if (raw !== undefined && !isObject(raw)) {
    return fail("task must be an object.");
  }

  const task = isObject(raw) ? raw : {};
  const objective = typeof task["objective"] === "string"
    ? task["objective"].trim()
    : fallbackObjective.trim();
  if (objective.length === 0) {
    return fail("task.objective is required for task items.");
  }

  const constraints = parseStringArray(task["constraints"], "task.constraints");
  if (isToolResult(constraints)) return constraints;
  const successCriteria = parseStringArray(task["successCriteria"], "task.successCriteria");
  if (isToolResult(successCriteria)) return successCriteria;

  const requestedAction = normalizeRequestedAction(
    typeof task["requestedAction"] === "string"
      ? task["requestedAction"]
      : fallbackRequestedAction ?? objective,
  );

  return {
    objective,
    ...(requestedAction ? { requestedAction } : {}),
    ...(isObject(task["inputs"]) ? { inputs: task["inputs"] } : {}),
    ...(isObject(task["context"]) ? { context: task["context"] } : {}),
    ...(constraints && constraints.length > 0 ? { constraints } : {}),
    ...(successCriteria && successCriteria.length > 0 ? { successCriteria } : {}),
  };
}

function parseTitle(raw: unknown, fallback: string): string | ToolResult {
  const candidate = typeof raw === "string" ? raw.trim() : fallback.trim();
  const title = candidate.slice(0, MAX_TITLE_CHARS).trim();
  if (title.length === 0) {
    return fail("title/instruction cannot be empty.");
  }
  return title;
}

function parseInstruction(raw: unknown, fallback: string): string | ToolResult {
  const value = typeof raw === "string" ? raw.trim() : fallback.trim();
  if (value.length === 0) {
    return fail("instruction (or message) is required.");
  }
  if (value.length > MAX_INSTRUCTION_CHARS) {
    return fail(`instruction must be ${MAX_INSTRUCTION_CHARS} characters or fewer.`);
  }
  return value;
}

function parseId(raw: unknown): string | ToolResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fail("id must be a non-empty string.");
  }
  return raw.trim();
}

function parseStatus(raw: unknown): PulseItemStatus | "all" | ToolResult {
  if (raw === undefined) return "active";
  if (raw === "active" || raw === "paused" || raw === "completed" || raw === "cancelled" || raw === "all") {
    return raw;
  }
  return fail("status must be one of: active, paused, completed, cancelled, all.");
}

function parseKind(rawKind: unknown, rawIntentKind: unknown): PulseItemKind | undefined | ToolResult {
  if (rawKind === undefined) {
    if (rawIntentKind === "task") return "task";
    if (rawIntentKind === "reminder") return "reminder";
    return undefined;
  }
  if (rawKind === "event" || rawKind === "reminder" || rawKind === "notification" || rawKind === "task") {
    return rawKind;
  }
  return fail("kind must be one of: event, reminder, notification, task.");
}

function parseListKind(raw: unknown): PulseItemKind | "all" | ToolResult {
  if (raw === undefined) return "all";
  if (raw === "all" || raw === "event" || raw === "reminder" || raw === "notification" || raw === "task") {
    return raw;
  }
  return fail("kind filter must be one of: all, event, reminder, notification, task.");
}

function parseLimit(raw: unknown): number | ToolResult {
  if (raw === undefined) return 20;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    return fail("limit must be a positive integer.");
  }
  return Math.min(200, raw);
}

function parseCount(raw: unknown): number | ToolResult {
  if (raw === undefined) return 5;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    return fail("count must be a positive integer.");
  }
  return Math.min(20, raw);
}

function parseDurationMs(rawDuration: unknown, rawDurationMs: unknown): number | ToolResult {
  if (typeof rawDurationMs === "number") {
    if (!Number.isFinite(rawDurationMs) || rawDurationMs <= 0) {
      return fail("durationMs must be a positive number.");
    }
    return rawDurationMs;
  }

  if (typeof rawDuration === "string") {
    const parsed = parseSnoozeDuration(rawDuration);
    if (!parsed) {
      return fail("duration must look like '15 minutes', '2 hours', etc.");
    }
    return parsed;
  }

  return fail("snooze requires duration or durationMs.");
}

function inferKind(
  requestedKind: PulseItemKind | undefined,
  instruction: string,
  title: string,
  hasTaskPayload: boolean,
  startAt: string | undefined,
): PulseItemKind {
  if (requestedKind) {
    return requestedKind;
  }
  if (hasTaskPayload) {
    return "task";
  }
  if (startAt) {
    return "event";
  }
  const seed = `${title} ${instruction}`.trim();
  if (REMINDER_INTENT_PATTERN.test(seed)) {
    return "reminder";
  }
  if (TASK_INTENT_PATTERN.test(seed)) {
    return "task";
  }
  return "reminder";
}

function formatScheduleText(schedule: PulseSchedule | null): string | null {
  if (!schedule) {
    return null;
  }
  if (schedule.kind === "once") {
    return `once at ${schedule.at}`;
  }
  if (schedule.kind === "daily") {
    return `every day at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }
  if (schedule.kind === "weekly") {
    const weekday = schedule.weekdays?.[0] ?? schedule.weekday ?? 1;
    return `every week on day ${weekday} at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }
  if (schedule.kind === "monthly") {
    return `every month on day ${schedule.day} at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }
  if (schedule.kind === "yearly") {
    return `every year on ${String(schedule.month).padStart(2, "0")}/${String(schedule.day).padStart(2, "0")} at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }
  const intervalValue = schedule.value ?? pulseIntervalMsToValueUnit(schedule.everyMs)?.value;
  const intervalUnit = schedule.unit ?? pulseIntervalMsToValueUnit(schedule.everyMs)?.unit;
  if (!intervalValue || !intervalUnit) {
    return `every ${schedule.everyMs} ms`;
  }
  return `every ${intervalValue} ${intervalUnit}${intervalValue === 1 ? "" : "s"}`;
}

function parseIsoDate(raw: unknown, fieldName: string): string | ToolResult | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fail(`${fieldName} must be a non-empty datetime string.`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return fail(`${fieldName} must be a valid datetime string.`);
  }
  return new Date(parsed).toISOString();
}

function parseStructuredSchedule(raw: unknown, timezone: string, now: Date): { schedule: PulseSchedule; nextTriggerAt: string } | ToolResult {
  if (!isObject(raw)) {
    return fail("schedule must be an object.");
  }
  const kind = raw["kind"];

  if (kind === "once") {
    const at = parseIsoDate(raw["at"], "schedule.at");
    if (isToolResult(at)) return at;
    if (!at) return fail("schedule.kind=once requires 'at'.");
    return {
      schedule: { kind: "once", at },
      nextTriggerAt: at,
    };
  }

  if (kind === "interval") {
    const rawValue = raw["value"];
    const rawUnit = raw["unit"];
    const intervalValue = typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue > 0
      ? Math.trunc(rawValue)
      : undefined;
    const intervalUnit = typeof rawUnit === "string" ? rawUnit as PulseDurationUnit : undefined;
    let everyMs = typeof raw["everyMs"] === "number" && Number.isFinite(raw["everyMs"]) && raw["everyMs"] > 0
      ? Math.trunc(raw["everyMs"])
      : undefined;

    if (intervalValue !== undefined && intervalUnit) {
      everyMs = pulseDurationToMillis(intervalValue, intervalUnit) ?? undefined;
    }
    if (everyMs === undefined) {
      return fail("schedule.kind=interval requires positive value/unit or everyMs.");
    }
    const normalized = pulseIntervalMsToValueUnit(everyMs);
    const schedule = {
      kind: "interval",
      everyMs,
      ...(intervalValue !== undefined ? { value: intervalValue } : normalized ? { value: normalized.value } : {}),
      ...(intervalUnit ? { unit: intervalUnit } : normalized ? { unit: normalized.unit } : {}),
      anchorAt: typeof raw["anchorAt"] === "string" && Number.isFinite(Date.parse(raw["anchorAt"]))
        ? new Date(Date.parse(raw["anchorAt"])).toISOString()
        : now.toISOString(),
    } satisfies PulseSchedule;
    return {
      schedule,
      nextTriggerAt: computeNextTriggerForSchedule(schedule, timezone, now) ?? new Date(now.getTime() + everyMs).toISOString(),
    };
  }

  if (kind === "daily") {
    const hour = raw["hour"];
    const minute = raw["minute"];
    if (typeof hour !== "number" || typeof minute !== "number") {
      return fail("schedule.kind=daily requires numeric hour and minute.");
    }
    const schedule: PulseDailySchedule = {
      kind: "daily",
      hour: Math.trunc(hour),
      minute: Math.trunc(minute),
    };
    const nextTriggerAt = computeNextTriggerForSchedule(schedule, timezone, now);
    if (!nextTriggerAt) return fail("failed to compute next daily trigger.");
    return { schedule, nextTriggerAt };
  }

  if (kind === "weekly") {
    const hour = raw["hour"];
    const minute = raw["minute"];
    if (typeof hour !== "number" || typeof minute !== "number") {
      return fail("schedule.kind=weekly requires numeric hour and minute.");
    }
    const weekday = typeof raw["weekday"] === "number" ? Math.trunc(raw["weekday"]) : undefined;
    const weekdays = Array.isArray(raw["weekdays"])
      ? raw["weekdays"].filter((entry): entry is number => typeof entry === "number").map((entry) => Math.trunc(entry))
      : undefined;
    if (weekday === undefined && (!weekdays || weekdays.length === 0)) {
      return fail("schedule.kind=weekly requires weekday or weekdays.");
    }
    const schedule: PulseWeeklySchedule = {
      kind: "weekly",
      ...(weekday !== undefined ? { weekday: weekday as PulseWeeklySchedule["weekday"] } : {}),
      ...(weekdays && weekdays.length > 0 ? { weekdays: weekdays as PulseWeeklySchedule["weekdays"] } : {}),
      hour: Math.trunc(hour),
      minute: Math.trunc(minute),
    };
    const nextTriggerAt = computeNextTriggerForSchedule(schedule, timezone, now);
    if (!nextTriggerAt) return fail("failed to compute next weekly trigger.");
    return { schedule, nextTriggerAt };
  }

  if (kind === "monthly") {
    const day = raw["day"];
    const hour = raw["hour"];
    const minute = raw["minute"];
    if (typeof day !== "number" || typeof hour !== "number" || typeof minute !== "number") {
      return fail("schedule.kind=monthly requires numeric day/hour/minute.");
    }
    const schedule: PulseMonthlySchedule = {
      kind: "monthly",
      day: Math.trunc(day),
      hour: Math.trunc(hour),
      minute: Math.trunc(minute),
    };
    const nextTriggerAt = computeNextTriggerForSchedule(schedule, timezone, now);
    if (!nextTriggerAt) return fail("failed to compute next monthly trigger.");
    return { schedule, nextTriggerAt };
  }

  if (kind === "yearly") {
    const month = raw["month"];
    const day = raw["day"];
    const hour = raw["hour"];
    const minute = raw["minute"];
    if (typeof month !== "number" || typeof day !== "number" || typeof hour !== "number" || typeof minute !== "number") {
      return fail("schedule.kind=yearly requires numeric month/day/hour/minute.");
    }
    const schedule: PulseYearlySchedule = {
      kind: "yearly",
      month: Math.trunc(month),
      day: Math.trunc(day),
      hour: Math.trunc(hour),
      minute: Math.trunc(minute),
    };
    const nextTriggerAt = computeNextTriggerForSchedule(schedule, timezone, now);
    if (!nextTriggerAt) return fail("failed to compute next yearly trigger.");
    return { schedule, nextTriggerAt };
  }

  return fail("unsupported schedule.kind. Use once, interval, daily, weekly, monthly, or yearly.");
}

function parsePayload(raw: CreateOrUpdateSeed, kind: PulseItemKind, instruction: string): PulseItemPayload | ToolResult {
  const payload: PulseItemPayload = {};
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== "string" && typeof raw.priority !== "number") {
      return fail("priority must be a string or number.");
    }
    payload.priority = raw.priority;
  }
  if (raw.tags !== undefined) {
    const tags = parseStringArray(raw.tags, "tags");
    if (isToolResult(tags)) return tags;
    if (tags) payload.tags = tags;
  }
  if (raw.requestedAction) {
    payload.requestedAction = normalizeRequestedAction(raw.requestedAction);
  }
  if (kind === "task") {
    const task = parseTaskSpec(raw.task, instruction, raw.requestedAction);
    if (isToolResult(task)) return task;
    payload.task = task;
    payload.requestedAction = task.requestedAction ?? payload.requestedAction;
  }
  return payload;
}

function hasPayloadChanges(raw: CreateOrUpdateSeed): boolean {
  return raw.task !== undefined
    || raw.requestedAction !== undefined
    || raw.priority !== undefined
    || raw.tags !== undefined;
}

function parseSeed(raw: Record<string, unknown>): CreateOrUpdateSeed | ToolResult {
  const kind = parseKind(raw["kind"], raw["intentKind"]);
  if (isToolResult(kind)) return kind;
  const tags = raw["tags"];
  if (tags !== undefined && !Array.isArray(tags)) {
    return fail("tags must be an array of strings.");
  }
  return {
    kind,
    intentKind: raw["intentKind"] === "reminder" || raw["intentKind"] === "task" ? raw["intentKind"] : undefined,
    title: typeof raw["title"] === "string" ? raw["title"] : undefined,
    instruction: typeof raw["instruction"] === "string" ? raw["instruction"] : undefined,
    message: typeof raw["message"] === "string" ? raw["message"] : undefined,
    when: typeof raw["when"] === "string" ? raw["when"] : undefined,
    every: typeof raw["every"] === "string" ? raw["every"] : undefined,
    timezone: typeof raw["timezone"] === "string" ? raw["timezone"] : undefined,
    metadata: isObject(raw["metadata"]) ? raw["metadata"] : undefined,
    schedule: isObject(raw["schedule"]) ? raw["schedule"] : undefined,
    startAt: typeof raw["startAt"] === "string" ? raw["startAt"] : undefined,
    endAt: typeof raw["endAt"] === "string" ? raw["endAt"] : undefined,
    durationMs: typeof raw["durationMs"] === "number" ? raw["durationMs"] : undefined,
    allDay: typeof raw["allDay"] === "boolean" ? raw["allDay"] : undefined,
    task: raw["task"],
    requestedAction: typeof raw["requestedAction"] === "string" ? raw["requestedAction"] : undefined,
    priority: typeof raw["priority"] === "string" || typeof raw["priority"] === "number" ? raw["priority"] : undefined,
    tags: Array.isArray(tags) ? tags.filter((entry): entry is string => typeof entry === "string") : undefined,
  };
}

function parseInput(input: unknown): PulseInput | ToolResult {
  if (!isObject(input)) {
    return fail("expected object.");
  }

  const action = parseAction(input["action"]);
  if (!action) {
    return fail("action must be one of: create, list, get, update, pause, resume, cancel, delete, snooze, dismiss, preview, now, health.");
  }

  if (action === "create") {
    const seed = parseSeed(input);
    if (isToolResult(seed)) return seed;
    return { action, ...seed };
  }

  if (action === "list") {
    const kind = parseListKind(input["kind"]);
    if (isToolResult(kind)) return kind;
    return {
      action,
      status: input["status"] as ListInput["status"],
      kind,
      limit: input["limit"] as number | undefined,
    };
  }

  if (action === "get" || action === "pause" || action === "resume" || action === "cancel" || action === "delete") {
    const id = parseId(input["id"]);
    if (isToolResult(id)) return id;
    return { action, id } as GetInput | PauseInput | ResumeInput | CancelInput | DeleteInput;
  }

  if (action === "update") {
    const id = parseId(input["id"]);
    if (isToolResult(id)) return id;
    const seed = parseSeed(input);
    if (isToolResult(seed)) return seed;
    return { action, id, ...seed };
  }

  if (action === "snooze") {
    const id = parseId(input["id"]);
    if (isToolResult(id)) return id;
    return {
      action,
      id,
      duration: typeof input["duration"] === "string" ? input["duration"] : undefined,
      durationMs: typeof input["durationMs"] === "number" ? input["durationMs"] : undefined,
    };
  }

  if (action === "dismiss") {
    const id = parseId(input["id"]);
    if (isToolResult(id)) return id;
    return {
      action,
      id,
      occurrenceId: typeof input["occurrenceId"] === "string" ? input["occurrenceId"] : undefined,
    };
  }

  if (action === "preview") {
    const seed = parseSeed(input);
    if (isToolResult(seed)) return seed;
    return {
      action,
      ...seed,
      id: typeof input["id"] === "string" ? input["id"] : undefined,
      count: typeof input["count"] === "number" ? input["count"] : undefined,
    };
  }

  if (action === "now" || action === "health") {
    return {
      action,
      timezone: typeof input["timezone"] === "string" ? input["timezone"] : undefined,
    };
  }

  return fail("unsupported pulse action.");
}

function formatPreview(preview: PulsePreviewOccurrence[]): Record<string, unknown>[] {
  return preview.map((entry) => ({
    index: entry.index,
    scheduledForUtc: entry.scheduledForUtc,
    timezone: entry.timezone,
    localDate: entry.localDate,
    localTime: entry.localTime,
    weekday: entry.weekday,
  }));
}

function formatItem(item: PulseItem): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    executionMode: item.executionMode,
    title: item.title,
    instruction: item.instruction,
    status: item.status,
    timezone: item.timezone,
    nextDueAt: item.nextDueAt,
    nextTriggerAt: item.nextDueAt,
    scheduleText: formatScheduleText(item.schedule),
    isRecurring: item.schedule ? item.schedule.kind !== "once" : false,
    schedule: item.schedule,
    startAt: item.startAtUtc,
    endAt: item.endAtUtc,
    durationMs: item.durationMs,
    allDay: item.allDay,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastDueAt: item.lastDueAt,
    lastCompletedAt: item.lastCompletedAt,
    requestedAction: item.payload.requestedAction ?? item.payload.task?.requestedAction,
    task: item.payload.task,
    payload: item.payload,
    metadata: item.metadata,
  };
}

function formatReminder(reminder: PulseReminder): Record<string, unknown> {
  return {
    id: reminder.id,
    intentKind: reminder.intentKind,
    title: reminder.title,
    instruction: reminder.instruction,
    status: reminder.status,
    timezone: reminder.timezone,
    nextTriggerAt: reminder.nextTriggerAt,
    scheduleText: formatScheduleText(reminder.schedule),
    isRecurring: reminder.schedule.kind !== "once",
    schedule: reminder.schedule,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
    lastTriggeredAt: reminder.lastTriggeredAt,
    requestedAction: reminder.requestedAction,
    task: reminder.task,
    metadata: reminder.metadata,
  };
}

function formatLegacyReminderFromItem(item: PulseItem): Record<string, unknown> {
  return {
    id: item.id,
    intentKind: item.kind === "task" ? "task" : "reminder",
    title: item.title,
    instruction: item.instruction,
    status: item.status === "paused" ? "active" : item.status,
    timezone: item.timezone,
    nextTriggerAt: item.nextDueAt,
    scheduleText: formatScheduleText(item.schedule),
    isRecurring: item.schedule ? item.schedule.kind !== "once" : false,
    schedule: item.schedule,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastTriggeredAt: item.lastDueAt,
    requestedAction: item.payload.requestedAction ?? item.payload.task?.requestedAction,
    task: item.payload.task,
    metadata: item.metadata,
  };
}

function toJsonOutput(payload: unknown): string {
  const text = JSON.stringify(payload, null, 2);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

function buildPreview(
  item: PulseItem | null,
  schedule: PulseSchedule | null,
  timezone: string,
  count: number,
  startAt?: string | null,
): PulsePreviewOccurrence[] {
  return previewPulseOccurrences(
    item?.schedule ?? schedule,
    item?.timezone ?? timezone,
    new Date(),
    count,
    item?.startAtUtc ?? startAt,
  );
}

export const pulseTool: ToolDefinition = {
  name: "pulse",
  description: "SQLite-backed calendar, reminder, notification, and scheduled-task management with previews and health checks.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        description: "One of: create, list, get, update, pause, resume, cancel, delete, snooze, dismiss, preview, now, health.",
      },
      kind: {
        type: "string",
        description: "event, reminder, notification, or task.",
      },
      intentKind: {
        type: "string",
        description: "Compatibility alias for reminder/task item creation.",
      },
      title: { type: "string" },
      instruction: { type: "string" },
      message: { type: "string", description: "Alias for instruction." },
      when: { type: "string", description: "Compatibility natural-language schedule expression for one-time items." },
      every: { type: "string", description: "Compatibility natural-language schedule expression for recurring items." },
      timezone: { type: "string", description: "IANA timezone, e.g. Asia/Kolkata." },
      requestedAction: { type: "string" },
      metadata: { type: "object" },
      startAt: { type: "string", description: "ISO datetime for passive events or explicit start time." },
      endAt: { type: "string", description: "ISO datetime end time." },
      durationMs: { type: "number", description: "Optional duration in milliseconds." },
      allDay: { type: "boolean" },
      priority: { type: ["string", "number"] },
      tags: { type: "array", items: { type: "string" } },
      schedule: {
        type: "object",
        description: "Preferred structured schedule object. Use once, interval, daily, weekly, monthly, or yearly.",
      },
      task: {
        type: "object",
        description: "Structured task payload for kind=task.",
      },
      id: { type: "string", description: "Pulse item id for get/update/pause/resume/cancel/delete/snooze/dismiss/preview." },
      occurrenceId: { type: "string", description: "Optional occurrence id for dismiss." },
      status: { type: "string", description: "Filter for list: active, paused, completed, cancelled, all." },
      limit: { type: "number" },
      count: { type: "number", description: "Number of preview occurrences to return." },
      duration: { type: "string", description: "Snooze duration like '30 minutes'." },
    },
  },
  selectionHints: {
    tags: ["reminder", "calendar", "schedule", "time", "date", "alarm", "task", "recurring-task"],
    aliases: ["set_reminder", "calendar", "remind_me", "schedule_reminder", "schedule_task", "set_recurring_task"],
    examples: [
      "remind me every one hour to check system health",
      "every morning browse AI news and summarize it",
      "create a passive event for tomorrow at 2pm",
      "show my active pulse items",
      "preview this monthly schedule",
      "check pulse clock health",
    ],
    domain: "time-management",
    priority: 98,
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = parseInput(input);
    if (isToolResult(parsed)) return parsed;

    const store = createStore();
    const clientId = context?.clientId ?? "local";
    const now = new Date();

    try {
      if (parsed.action === "now") {
        const snapshot = store.getNowSnapshot(parsed.timezone);
        return {
          ok: true,
          output: toJsonOutput({ action: "now", snapshot }),
          meta: { action: "now" },
        };
      }

      if (parsed.action === "health") {
        const health: PulseClockHealth = store.getClockHealth(parsed.timezone);
        return {
          ok: true,
          output: toJsonOutput({ action: "health", health }),
          meta: { action: "health", syncHealthy: health.syncHealthy },
        };
      }

      if (parsed.action === "list") {
        const status = parseStatus(parsed.status);
        if (isToolResult(status)) return status;
        const limit = parseLimit(parsed.limit);
        if (isToolResult(limit)) return limit;
        const items = await store.listItems({ clientId, status, kind: parsed.kind, limit });
        const reminders = await store.listReminders({ clientId, status: status === "paused" ? "active" : status, limit });
        return {
          ok: true,
          output: toJsonOutput({
            action: "list",
            total: items.length,
            items: items.map((item) => formatItem(item)),
            reminders: reminders.map((reminder) => formatReminder(reminder)),
          }),
          meta: { action: "list", count: items.length },
        };
      }

      if (parsed.action === "get") {
        const details = await store.getItemDetails(clientId, parsed.id);
        if (!details) {
          return { ok: false, error: `Pulse item not found: ${parsed.id}` };
        }
        return {
          ok: true,
          output: toJsonOutput({
            action: "get",
            item: formatItem(details.item),
            occurrences: details.occurrences,
            history: details.history,
          }),
          meta: { action: "get", itemId: details.item.id },
        };
      }

      if (parsed.action === "pause") {
        const item = await store.pauseItem(clientId, parsed.id);
        if (!item) {
          return { ok: false, error: `Pulse item not found: ${parsed.id}` };
        }
        return {
          ok: true,
          output: toJsonOutput({
            action: "pause",
            item: formatItem(item),
            ...(item.kind === "reminder" || item.kind === "task" ? { reminder: formatLegacyReminderFromItem(item) } : {}),
          }),
          meta: { action: "pause", itemId: item.id },
        };
      }

      if (parsed.action === "resume") {
        const item = await store.resumeItem(clientId, parsed.id);
        if (!item) {
          return { ok: false, error: `Pulse item not found: ${parsed.id}` };
        }
        const preview = buildPreview(item, null, item.timezone, 5, item.startAtUtc);
        return {
          ok: true,
          output: toJsonOutput({
            action: "resume",
            item: formatItem(item),
            ...(item.kind === "reminder" || item.kind === "task" ? { reminder: formatLegacyReminderFromItem(item) } : {}),
            preview: formatPreview(preview),
          }),
          meta: { action: "resume", itemId: item.id },
        };
      }

      if (parsed.action === "cancel") {
        const item = await store.cancelItem(clientId, parsed.id);
        if (!item) {
          return { ok: false, error: `Pulse item not found: ${parsed.id}` };
        }
        return {
          ok: true,
          output: toJsonOutput({
            action: "cancel",
            item: formatItem(item),
            ...(item.kind === "reminder" || item.kind === "task" ? { reminder: formatLegacyReminderFromItem(item) } : {}),
          }),
          meta: { action: "cancel", itemId: item.id },
        };
      }

      if (parsed.action === "delete") {
        const deleted = await store.deleteItem(clientId, parsed.id);
        if (!deleted) {
          return { ok: false, error: `Pulse item not found: ${parsed.id}` };
        }
        return {
          ok: true,
          output: toJsonOutput({ action: "delete", id: parsed.id, deleted: true }),
          meta: { action: "delete", itemId: parsed.id },
        };
      }

      if (parsed.action === "snooze") {
        const durationMs = parseDurationMs(parsed.duration, parsed.durationMs);
        if (isToolResult(durationMs)) return durationMs;
        const item = await store.snoozeItem(clientId, parsed.id, durationMs);
        if (!item) {
          return { ok: false, error: `Pulse item not found or not snoozable: ${parsed.id}` };
        }
        const preview = buildPreview(item, null, item.timezone, 5, item.startAtUtc);
        return {
          ok: true,
          output: toJsonOutput({
            action: "snooze",
            item: formatItem(item),
            ...(item.kind === "reminder" || item.kind === "task" ? { reminder: formatLegacyReminderFromItem(item) } : {}),
            preview: formatPreview(preview),
          }),
          meta: { action: "snooze", itemId: item.id, durationMs },
        };
      }

      if (parsed.action === "dismiss") {
        const item = await store.dismissItem({
          clientId,
          itemId: parsed.id,
          occurrenceId: parsed.occurrenceId,
          now,
        });
        if (!item) {
          return { ok: false, error: `Pulse item not found or not dismissable: ${parsed.id}` };
        }
        const preview = buildPreview(item, null, item.timezone, 5, item.startAtUtc);
        return {
          ok: true,
          output: toJsonOutput({
            action: "dismiss",
            item: formatItem(item),
            ...(item.kind === "reminder" || item.kind === "task" ? { reminder: formatLegacyReminderFromItem(item) } : {}),
            preview: formatPreview(preview),
          }),
          meta: { action: "dismiss", itemId: item.id },
        };
      }

      if (parsed.action === "preview") {
        const count = parseCount(parsed.count);
        if (isToolResult(count)) return count;
        if (parsed.id) {
          const details = await store.getItemDetails(clientId, parsed.id);
          if (!details) {
            return { ok: false, error: `Pulse item not found: ${parsed.id}` };
          }
          const preview = buildPreview(details.item, null, details.item.timezone, count, details.item.startAtUtc);
          return {
            ok: true,
            output: toJsonOutput({ action: "preview", item: formatItem(details.item), preview: formatPreview(preview) }),
            meta: { action: "preview", itemId: details.item.id, count },
          };
        }

        const timezone = resolveTimeZone(parsed.timezone);
        const scheduleInfo = resolveScheduleSeed(parsed, timezone, now, false);
        if (isToolResult(scheduleInfo)) return scheduleInfo;
        const startAt = parseIsoDate(parsed.startAt, "startAt");
        if (isToolResult(startAt)) return startAt;
        const preview = buildPreview(null, scheduleInfo?.schedule ?? null, timezone, count, startAt ?? null);
        return {
          ok: true,
          output: toJsonOutput({ action: "preview", preview: formatPreview(preview), schedule: scheduleInfo?.schedule ?? null }),
          meta: { action: "preview", count },
        };
      }

      const existingItem = parsed.action === "update"
        ? await store.getItem(clientId, parsed.id)
        : null;
      if (parsed.action === "update" && !existingItem) {
        return { ok: false, error: `Pulse item not found: ${parsed.id}` };
      }

      const timezone = resolveTimeZone(parsed.timezone ?? existingItem?.timezone);
      const taskObjectiveSeed = isObject(parsed.task) && typeof parsed.task["objective"] === "string"
        ? parsed.task["objective"]
        : "";
      const instructionSeed = parsed.instruction
        ?? parsed.message
        ?? parsed.title
        ?? taskObjectiveSeed
        ?? existingItem?.instruction
        ?? "";
      const instruction = parseInstruction(parsed.instruction ?? parsed.message, instructionSeed);
      if (isToolResult(instruction)) return instruction;

      const title = parseTitle(parsed.title, existingItem?.title ?? instruction);
      if (isToolResult(title)) return title;

      const kind = inferKind(parsed.kind ?? existingItem?.kind, instruction, title, parsed.task !== undefined, parsed.startAt);
      const payload = parsed.action === "create" || hasPayloadChanges(parsed)
        ? parsePayload(parsed, kind, instruction)
        : undefined;
      if (isToolResult(payload)) return payload;

      const startAt = parseIsoDate(parsed.startAt, "startAt");
      if (isToolResult(startAt)) return startAt;
      const endAt = parseIsoDate(parsed.endAt, "endAt");
      if (isToolResult(endAt)) return endAt;

      const scheduleInfo = resolveScheduleSeed(parsed, timezone, now, parsed.action === "create" && kind !== "event");
      if (isToolResult(scheduleInfo)) return scheduleInfo;

      if (parsed.action === "create") {
        const item = await store.createItem({
          clientId,
          kind,
          title,
          instruction,
          timezone,
          schedule: scheduleInfo?.schedule ?? null,
          nextDueAt: scheduleInfo?.nextTriggerAt,
          payload: {
            ...(payload ?? {}),
            ...(context?.runId ? { originRunId: context.runId } : {}),
            ...(context?.sessionId ? { originSessionId: context.sessionId } : {}),
          },
          metadata: parsed.metadata,
          startAtUtc: startAt ?? null,
          endAtUtc: endAt ?? null,
          durationMs: parsed.durationMs,
          allDay: parsed.allDay,
        });
        const preview = buildPreview(item, null, timezone, 5, item.startAtUtc);
        return {
          ok: true,
          output: toJsonOutput({
            action: "create",
            item: formatItem(item),
            ...(item.kind === "reminder" || item.kind === "task" ? { reminder: formatLegacyReminderFromItem(item) } : {}),
            preview: formatPreview(preview),
          }),
          meta: {
            action: "create",
            itemId: item.id,
            nextDueAt: item.nextDueAt,
          },
        };
      }

      const item = await store.updateItem(clientId, parsed.id, {
        title,
        instruction,
        timezone,
        schedule: scheduleInfo?.schedule ?? undefined,
        ...(payload !== undefined ? { payload } : {}),
        metadata: parsed.metadata,
        ...(startAt !== undefined ? { startAtUtc: startAt } : {}),
        ...(endAt !== undefined ? { endAtUtc: endAt } : {}),
        durationMs: parsed.durationMs,
        allDay: parsed.allDay,
        ...(scheduleInfo?.nextTriggerAt !== undefined ? { nextDueAt: scheduleInfo.nextTriggerAt } : {}),
      });
      if (!item) {
        return { ok: false, error: `Pulse item not found: ${parsed.id}` };
      }
      const preview = buildPreview(item, null, timezone, 5, item.startAtUtc);
      return {
        ok: true,
        output: toJsonOutput({
          action: "update",
          item: formatItem(item),
          ...(item.kind === "reminder" || item.kind === "task" ? { reminder: formatLegacyReminderFromItem(item) } : {}),
          preview: formatPreview(preview),
        }),
        meta: {
          action: "update",
          itemId: item.id,
          nextDueAt: item.nextDueAt,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Pulse tool failed",
      };
    } finally {
      store.close();
    }
  },
};

function resolveScheduleSeed(
  parsed: CreateOrUpdateSeed | PreviewInput,
  timezone: string,
  now: Date,
  requireSchedule: boolean,
): { schedule: PulseSchedule; nextTriggerAt: string } | null | ToolResult {
  if (parsed.schedule) {
    return parseStructuredSchedule(parsed.schedule, timezone, now);
  }
  const expression = parsed.every?.trim() || parsed.when?.trim() || "";
  if (expression.length === 0) {
    return requireSchedule ? fail("create/update requires one of: schedule, when, every.") : null;
  }
  const parsedExpression = parsePulseExpression(expression, timezone, now);
  if (!parsedExpression) {
    return fail("unable to parse schedule expression. Try examples like 'tomorrow at 9am', 'every 1 hour', or provide a structured schedule object.");
  }
  return {
    schedule: parsedExpression.schedule,
    nextTriggerAt: parsedExpression.nextTriggerAt,
  };
}

const PULSE_PROMPT_BLOCK = [
  "The `pulse` tool is built in.",
  "Use it directly for reminders, schedules, recurring checks, periodic browsing, periodic monitoring, dates, or times.",
  "Pulse V2 stores all schedule state in SQLite and supports events, reminders, notifications, and executable scheduled tasks.",
  "Use action=create, update, list, get, pause, resume, cancel, delete, snooze, dismiss, preview, now, and health as needed.",
  "Use kind=event for passive calendar records, kind=reminder or kind=notification for internal notifications, and kind=task for scheduled agent work.",
  "Prefer structured schedule objects when possible. Supported recurrence kinds are once, interval, daily, weekly, monthly, and yearly.",
  "After create or update, inspect the preview output to confirm schedule math before relying on it for important work.",
  "For scheduled tasks, include task.objective and task.requestedAction when known so future system_event handling has enough execution context.",
  "When the user accepts an assistant-suggested recurring Pulse routine, create kind=task with requestedAction=run_responsibility and metadata.source=pulse_proposal.",
].join("\n");

const pulseSkill: SkillDefinition = {
  id: "pulse",
  version: "1.0.0",
  description: "Persistent SQLite-backed calendar, reminder, notification, and scheduled-task orchestration for time-based agent work.",
  promptBlock: PULSE_PROMPT_BLOCK,
  tools: [pulseTool],
};

export default pulseSkill;
