import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeNextTriggerForSchedule, normalizePulseDurationUnit, pulseDurationToMillis, pulseIntervalMsToValueUnit } from "./parser.js";
import { getZonedDateParts, resolveTimeZone, toDateLabel, toTimeLabel, weekdayName } from "./time.js";
import type {
  PulseCreateReminderInput,
  PulseScheduledItemIntentKind,
  PulseListRemindersOptions,
  PulseMarkDeliveredInput,
  PulseNowSnapshot,
  PulseReminder,
  PulseTaskSpec,
  PulseStoreDocument,
} from "./types.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_STORE_FILE_PATH = resolve(projectRoot, "data", "pulse", "reminders.json");

const PULSE_STORE_PATH_ENV = "PULSE_STORE_FILE_PATH";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

let operationLock: Promise<void> = Promise.resolve();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidReminder(value: unknown): value is PulseReminder {
  if (!isObject(value)) return false;
  if (typeof value["id"] !== "string") return false;
  if (typeof value["clientId"] !== "string") return false;
  if (
    value["intentKind"] !== undefined
    && value["intentKind"] !== "reminder"
    && value["intentKind"] !== "task"
  ) {
    return false;
  }
  if (typeof value["title"] !== "string") return false;
  if (typeof value["instruction"] !== "string") return false;
  if (typeof value["timezone"] !== "string") return false;
  if (value["status"] !== "active" && value["status"] !== "completed" && value["status"] !== "cancelled") {
    return false;
  }
  if (!isObject(value["schedule"])) return false;
  if (value["nextTriggerAt"] !== null && typeof value["nextTriggerAt"] !== "string") return false;
  if (typeof value["createdAt"] !== "string") return false;
  if (typeof value["updatedAt"] !== "string") return false;
  if (value["requestedAction"] !== undefined && typeof value["requestedAction"] !== "string") return false;
  if (value["task"] !== undefined && !isObject(value["task"])) return false;
  if (!isObject(value["metadata"])) return false;
  return true;
}

function isValidStoreDocument(value: unknown): value is PulseStoreDocument {
  if (!isObject(value)) return false;
  if (value["version"] !== 1) return false;
  if (!Array.isArray(value["reminders"])) return false;
  return value["reminders"].every((item) => isValidReminder(item));
}

function normalizeIntentKind(value: unknown): PulseScheduledItemIntentKind {
  return value === "task" ? "task" : "reminder";
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizeTaskSpec(value: unknown): PulseTaskSpec | undefined {
  if (!isObject(value)) return undefined;
  const objective = typeof value["objective"] === "string" ? value["objective"].trim() : "";
  if (objective.length === 0) return undefined;

  const requestedAction = typeof value["requestedAction"] === "string" && value["requestedAction"].trim().length > 0
    ? value["requestedAction"].trim()
    : undefined;
  const constraints = sanitizeStringArray(value["constraints"]);
  const successCriteria = sanitizeStringArray(value["successCriteria"]);

  return {
    objective,
    ...(requestedAction ? { requestedAction } : {}),
    ...(isObject(value["inputs"]) ? { inputs: value["inputs"] } : {}),
    ...(isObject(value["context"]) ? { context: value["context"] } : {}),
    ...(constraints ? { constraints } : {}),
    ...(successCriteria ? { successCriteria } : {}),
  };
}

function normalizeSchedule(schedule: PulseReminder["schedule"]): PulseReminder["schedule"] {
  if (!isObject(schedule) || schedule["kind"] !== "interval") {
    return schedule;
  }

  const existingEveryMs = typeof schedule["everyMs"] === "number" && Number.isFinite(schedule["everyMs"]) && schedule["everyMs"] > 0
    ? schedule["everyMs"]
    : undefined;
  const existingValue = typeof schedule["value"] === "number" && Number.isFinite(schedule["value"]) && schedule["value"] > 0
    ? Math.trunc(schedule["value"])
    : undefined;
  const existingUnit = typeof schedule["unit"] === "string"
    ? normalizePulseDurationUnit(schedule["unit"])
    : null;

  const everyMs = existingEveryMs ?? (existingValue && existingUnit ? pulseDurationToMillis(existingValue, existingUnit) ?? undefined : undefined);
  const derived = everyMs !== undefined ? pulseIntervalMsToValueUnit(everyMs) : null;
  const value = existingValue ?? derived?.value;
  const unit = existingUnit ?? derived?.unit;

  return {
    ...schedule,
    ...(everyMs !== undefined ? { everyMs } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(unit ? { unit } : {}),
  } as PulseReminder["schedule"];
}

function normalizeReminder(value: PulseReminder): PulseReminder {
  const task = normalizeTaskSpec(value.task);
  const requestedAction = typeof value.requestedAction === "string" && value.requestedAction.trim().length > 0
    ? value.requestedAction.trim()
    : undefined;
  const normalizedRequestedAction = task?.requestedAction ?? requestedAction;
  const normalizedTask = task && normalizedRequestedAction && !task.requestedAction
    ? { ...task, requestedAction: normalizedRequestedAction }
    : task;

  const normalized: PulseReminder = {
    ...value,
    intentKind: normalizeIntentKind(value.intentKind),
    schedule: normalizeSchedule(value.schedule),
  };

  if (normalizedRequestedAction) {
    normalized.requestedAction = normalizedRequestedAction;
  } else {
    delete normalized.requestedAction;
  }

  if (normalizedTask) {
    normalized.task = normalizedTask;
  } else {
    delete normalized.task;
  }

  return normalized;
}

function getStoreFilePath(): string {
  const fromEnv = process.env[PULSE_STORE_PATH_ENV]?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return DEFAULT_STORE_FILE_PATH;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
  const integer = Math.trunc(limit);
  return Math.max(1, Math.min(MAX_LIST_LIMIT, integer));
}

async function loadDocument(filePath: string): Promise<PulseStoreDocument> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidStoreDocument(parsed)) {
      throw new Error("Pulse store has invalid shape.");
    }
    return {
      version: 1,
      reminders: parsed.reminders.map((item) => normalizeReminder(item)),
    };
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, reminders: [] };
    }
    throw err;
  }
}

async function saveDocument(filePath: string, document: PulseStoreDocument): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, JSON.stringify(document, null, 2), "utf8");
  await rename(tmpPath, filePath);
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = operationLock;
  let release: () => void = () => undefined;
  operationLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export interface PulseStoreOptions {
  filePath?: string;
  now?: () => Date;
}

export class PulseStore {
  private readonly filePath: string;
  private readonly nowProvider: () => Date;

  constructor(options?: PulseStoreOptions) {
    this.filePath = options?.filePath ?? getStoreFilePath();
    this.nowProvider = options?.now ?? (() => new Date());
  }

  async createReminder(input: PulseCreateReminderInput): Promise<PulseReminder> {
    const nowIso = this.nowProvider().toISOString();
    const timezone = resolveTimeZone(input.timezone);

    return withLock(async () => {
      const document = await loadDocument(this.filePath);
      const reminder: PulseReminder = {
        id: randomUUID(),
        clientId: input.clientId,
        intentKind: normalizeIntentKind(input.intentKind),
        title: input.title,
        instruction: input.instruction,
        timezone,
        status: "active",
        schedule: input.schedule,
        nextTriggerAt: input.nextTriggerAt,
        createdAt: nowIso,
        updatedAt: nowIso,
        metadata: input.metadata ?? {},
        originRunId: input.originRunId,
        originSessionId: input.originSessionId,
        ...(typeof input.requestedAction === "string" && input.requestedAction.trim().length > 0
          ? { requestedAction: input.requestedAction.trim() }
          : {}),
        ...(input.task ? { task: input.task } : {}),
      };

      document.reminders.unshift(reminder);
      await saveDocument(this.filePath, document);
      return reminder;
    });
  }

  async listReminders(options: PulseListRemindersOptions): Promise<PulseReminder[]> {
    const statusFilter = options.status ?? "active";
    const limit = clampLimit(options.limit);

    return withLock(async () => {
      const document = await loadDocument(this.filePath);
      const items = document.reminders
        .filter((reminder) => reminder.clientId === options.clientId)
        .filter((reminder) => statusFilter === "all" || reminder.status === statusFilter)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
      return items;
    });
  }

  async cancelReminder(clientId: string, reminderId: string): Promise<PulseReminder | null> {
    const nowIso = this.nowProvider().toISOString();

    return withLock(async () => {
      const document = await loadDocument(this.filePath);
      const reminder = document.reminders.find((item) => item.clientId === clientId && item.id === reminderId);
      if (!reminder) return null;

      reminder.status = "cancelled";
      reminder.nextTriggerAt = null;
      reminder.updatedAt = nowIso;
      await saveDocument(this.filePath, document);
      return reminder;
    });
  }

  async snoozeReminder(clientId: string, reminderId: string, delayMs: number): Promise<PulseReminder | null> {
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      throw new Error("Snooze delay must be a positive duration.");
    }

    const now = this.nowProvider();
    const nowIso = now.toISOString();
    const next = new Date(now.getTime() + delayMs).toISOString();

    return withLock(async () => {
      const document = await loadDocument(this.filePath);
      const reminder = document.reminders.find((item) => item.clientId === clientId && item.id === reminderId);
      if (!reminder) return null;
      if (reminder.status === "cancelled") return null;

      reminder.status = "active";
      reminder.nextTriggerAt = next;
      reminder.updatedAt = nowIso;
      await saveDocument(this.filePath, document);
      return reminder;
    });
  }

  async getDueReminders(clientId: string, nowInput?: Date): Promise<PulseReminder[]> {
    const now = nowInput ?? this.nowProvider();
    const nowMs = now.getTime();

    return withLock(async () => {
      const document = await loadDocument(this.filePath);
      return document.reminders
        .filter((reminder) => reminder.clientId === clientId)
        .filter((reminder) => reminder.status === "active")
        .filter((reminder) => typeof reminder.nextTriggerAt === "string")
        .filter((reminder) => {
          const triggerMs = Date.parse(reminder.nextTriggerAt ?? "");
          return Number.isFinite(triggerMs) && triggerMs <= nowMs;
        })
        .sort((a, b) => {
          const aMs = Date.parse(a.nextTriggerAt ?? "");
          const bMs = Date.parse(b.nextTriggerAt ?? "");
          return aMs - bMs;
        });
    });
  }

  async markDelivered(input: PulseMarkDeliveredInput): Promise<PulseReminder | null> {
    const now = this.nowProvider();
    const nowIso = now.toISOString();

    return withLock(async () => {
      const document = await loadDocument(this.filePath);
      const reminder = document.reminders.find((item) => item.clientId === input.clientId && item.id === input.reminderId);
      if (!reminder) return null;
      if (reminder.status !== "active") return reminder;
      if (reminder.lastDeliveredOccurrenceId === input.occurrenceId) {
        return reminder;
      }

      reminder.lastDeliveredOccurrenceId = input.occurrenceId;
      reminder.lastTriggeredAt = input.triggeredAt;

      const next = computeNextTriggerForSchedule(
        reminder.schedule,
        reminder.timezone,
        now,
        input.scheduledFor,
      );

      if (next === null) {
        reminder.status = "completed";
        reminder.nextTriggerAt = null;
      } else {
        reminder.status = "active";
        reminder.nextTriggerAt = next;
      }

      reminder.updatedAt = nowIso;
      await saveDocument(this.filePath, document);
      return reminder;
    });
  }

  getNowSnapshot(timezoneInput?: string): PulseNowSnapshot {
    const timezone = resolveTimeZone(timezoneInput);
    const now = this.nowProvider();
    const parts = getZonedDateParts(now, timezone);

    return {
      nowUtc: now.toISOString(),
      timezone,
      localDate: toDateLabel(parts),
      localTime: toTimeLabel(parts),
      weekday: weekdayName(parts.weekday),
    };
  }
}
