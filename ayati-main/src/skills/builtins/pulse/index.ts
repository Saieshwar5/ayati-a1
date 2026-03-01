import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import { computeNextTriggerForSchedule, parsePulseExpression, parseSnoozeDuration } from "../../../pulse/parser.js";
import { PulseStore } from "../../../pulse/store.js";
import { resolveTimeZone } from "../../../pulse/time.js";
import type {
  PulseDailySchedule,
  PulseIntervalSchedule,
  PulseReminder,
  PulseReminderSchedule,
  PulseReminderStatus,
  PulseWeeklySchedule,
} from "../../../pulse/types.js";

type PulseAction = "create" | "list" | "cancel" | "snooze" | "now";

const MAX_TITLE_CHARS = 160;
const MAX_INSTRUCTION_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 120_000;

interface CreateInput {
  action: "create";
  title?: string;
  instruction?: string;
  message?: string;
  when?: string;
  every?: string;
  timezone?: string;
  metadata?: Record<string, unknown>;
  schedule?: Record<string, unknown>;
}

interface ListInput {
  action: "list";
  status?: PulseReminderStatus | "all";
  limit?: number;
}

interface CancelInput {
  action: "cancel";
  id: string;
}

interface SnoozeInput {
  action: "snooze";
  id: string;
  duration?: string;
  durationMs?: number;
}

interface NowInput {
  action: "now";
  timezone?: string;
}

type PulseInput = CreateInput | ListInput | CancelInput | SnoozeInput | NowInput;

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
  if (raw === "create" || raw === "list" || raw === "cancel" || raw === "snooze" || raw === "now") {
    return raw;
  }
  return null;
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
    return fail("instruction (or message) is required for create.");
  }
  if (value.length > MAX_INSTRUCTION_CHARS) {
    return fail(`instruction must be ${MAX_INSTRUCTION_CHARS} characters or fewer.`);
  }
  return value;
}

function parseReminderId(raw: unknown): string | ToolResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fail("id must be a non-empty string.");
  }
  return raw.trim();
}

function parseStatus(raw: unknown): PulseReminderStatus | "all" | ToolResult {
  if (raw === undefined) return "active";
  if (raw === "active" || raw === "completed" || raw === "cancelled" || raw === "all") {
    return raw;
  }
  return fail("status must be one of: active, completed, cancelled, all.");
}

function parseLimit(raw: unknown): number | ToolResult {
  if (raw === undefined) return 20;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    return fail("limit must be a positive integer.");
  }
  return Math.min(200, raw);
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

function parseStructuredSchedule(raw: unknown, timezone: string, now: Date): { schedule: PulseReminderSchedule; nextTriggerAt: string } | ToolResult {
  if (!isObject(raw)) {
    return fail("schedule must be an object.");
  }
  const kind = raw["kind"];
  if (kind === "once") {
    if (typeof raw["at"] !== "string") {
      return fail("schedule.kind=once requires 'at' (ISO date string).");
    }
    const atMs = Date.parse(raw["at"]);
    if (!Number.isFinite(atMs)) {
      return fail("schedule.at must be a valid datetime string.");
    }
    return {
      schedule: { kind: "once", at: new Date(atMs).toISOString() },
      nextTriggerAt: new Date(atMs).toISOString(),
    };
  }

  if (kind === "interval") {
    const everyMs = raw["everyMs"];
    if (typeof everyMs !== "number" || !Number.isFinite(everyMs) || everyMs <= 0) {
      return fail("schedule.kind=interval requires positive number everyMs.");
    }
    const schedule: PulseIntervalSchedule = {
      kind: "interval",
      everyMs,
      anchorAt: now.toISOString(),
    };
    return {
      schedule,
      nextTriggerAt: new Date(now.getTime() + everyMs).toISOString(),
    };
  }

  if (kind === "daily") {
    const hour = raw["hour"];
    const minute = raw["minute"];
    if (typeof hour !== "number" || typeof minute !== "number") {
      return fail("schedule.kind=daily requires numeric hour and minute.");
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      return fail("daily hour must be 0-23 and minute must be 0-59.");
    }
    const schedule: PulseDailySchedule = {
      kind: "daily",
      hour,
      minute,
    };
    const nextTriggerAt = computeNextTriggerForSchedule(schedule, timezone, now);
    if (!nextTriggerAt) {
      return fail("failed to compute next daily trigger.");
    }
    return { schedule, nextTriggerAt };
  }

  if (kind === "weekly") {
    const weekday = raw["weekday"];
    const hour = raw["hour"];
    const minute = raw["minute"];
    if (typeof weekday !== "number" || typeof hour !== "number" || typeof minute !== "number") {
      return fail("schedule.kind=weekly requires numeric weekday/hour/minute.");
    }
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      return fail("weekly weekday must be 1-7 (Mon-Sun).");
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      return fail("weekly hour must be 0-23 and minute must be 0-59.");
    }
    const schedule: PulseWeeklySchedule = {
      kind: "weekly",
      weekday: weekday as PulseWeeklySchedule["weekday"],
      hour,
      minute,
    };
    const nextTriggerAt = computeNextTriggerForSchedule(schedule, timezone, now);
    if (!nextTriggerAt) {
      return fail("failed to compute next weekly trigger.");
    }
    return { schedule, nextTriggerAt };
  }

  return fail("unsupported schedule.kind. Use once, interval, daily, or weekly.");
}

function parseInput(input: unknown): PulseInput | ToolResult {
  if (!isObject(input)) {
    return fail("expected object.");
  }

  const action = parseAction(input["action"]);
  if (!action) {
    return fail("action must be one of: create, list, cancel, snooze, now.");
  }

  if (action === "create") {
    const parsed: CreateInput = {
      action,
      title: typeof input["title"] === "string" ? input["title"] : undefined,
      instruction: typeof input["instruction"] === "string" ? input["instruction"] : undefined,
      message: typeof input["message"] === "string" ? input["message"] : undefined,
      when: typeof input["when"] === "string" ? input["when"] : undefined,
      every: typeof input["every"] === "string" ? input["every"] : undefined,
      timezone: typeof input["timezone"] === "string" ? input["timezone"] : undefined,
      metadata: isObject(input["metadata"]) ? input["metadata"] : undefined,
      schedule: isObject(input["schedule"]) ? input["schedule"] : undefined,
    };
    return parsed;
  }

  if (action === "list") {
    return {
      action,
      status: input["status"] as ListInput["status"],
      limit: input["limit"] as number | undefined,
    };
  }

  if (action === "cancel") {
    const id = parseReminderId(input["id"]);
    if (isToolResult(id)) return id;
    return { action, id };
  }

  if (action === "snooze") {
    const id = parseReminderId(input["id"]);
    if (isToolResult(id)) return id;
    return {
      action,
      id,
      duration: typeof input["duration"] === "string" ? input["duration"] : undefined,
      durationMs: typeof input["durationMs"] === "number" ? input["durationMs"] : undefined,
    };
  }

  return {
    action,
    timezone: typeof input["timezone"] === "string" ? input["timezone"] : undefined,
  };
}

function formatReminder(reminder: PulseReminder): Record<string, unknown> {
  return {
    id: reminder.id,
    title: reminder.title,
    instruction: reminder.instruction,
    status: reminder.status,
    timezone: reminder.timezone,
    nextTriggerAt: reminder.nextTriggerAt,
    schedule: reminder.schedule,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
    lastTriggeredAt: reminder.lastTriggeredAt,
    metadata: reminder.metadata,
  };
}

function toJsonOutput(payload: unknown): string {
  const text = JSON.stringify(payload, null, 2);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

export const pulseTool: ToolDefinition = {
  name: "pulse",
  description: "Calendar and reminder management. Create, list, cancel, snooze reminders and query current time.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        description: "One of: create, list, cancel, snooze, now.",
      },
      title: { type: "string", description: "Reminder title." },
      instruction: { type: "string", description: "Instruction/message for the reminder." },
      message: { type: "string", description: "Alias for instruction." },
      when: { type: "string", description: "Natural-language schedule expression for one-time reminders." },
      every: { type: "string", description: "Natural-language recurring schedule, e.g. every 1 hour." },
      timezone: { type: "string", description: "IANA timezone, e.g. Asia/Kolkata." },
      metadata: { type: "object", description: "Optional metadata object." },
      schedule: { type: "object", description: "Optional structured schedule object." },
      id: { type: "string", description: "Reminder ID for cancel/snooze." },
      status: { type: "string", description: "Filter for list: active, completed, cancelled, all." },
      limit: { type: "number", description: "Max reminders in list response." },
      duration: { type: "string", description: "Snooze duration like '30 minutes'." },
      durationMs: { type: "number", description: "Snooze duration in milliseconds." },
    },
  },
  selectionHints: {
    tags: ["reminder", "calendar", "schedule", "time", "date", "alarm"],
    aliases: ["set_reminder", "calendar", "remind_me", "schedule_reminder"],
    examples: [
      "remind me every one hour to check system health",
      "remind me tomorrow about my girlfriend birthday",
      "show my active reminders",
      "cancel reminder 123",
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

      if (parsed.action === "list") {
        const status = parseStatus(parsed.status);
        if (isToolResult(status)) return status;
        const limit = parseLimit(parsed.limit);
        if (isToolResult(limit)) return limit;
        const reminders = await store.listReminders({ clientId, status, limit });
        return {
          ok: true,
          output: toJsonOutput({
            action: "list",
            total: reminders.length,
            reminders: reminders.map((reminder) => formatReminder(reminder)),
          }),
          meta: { action: "list", count: reminders.length },
        };
      }

      if (parsed.action === "cancel") {
        const reminder = await store.cancelReminder(clientId, parsed.id);
        if (!reminder) {
          return { ok: false, error: `Reminder not found: ${parsed.id}` };
        }
        return {
          ok: true,
          output: toJsonOutput({ action: "cancel", reminder: formatReminder(reminder) }),
          meta: { action: "cancel", reminderId: reminder.id },
        };
      }

      if (parsed.action === "snooze") {
        const durationMs = parseDurationMs(parsed.duration, parsed.durationMs);
        if (isToolResult(durationMs)) return durationMs;
        const reminder = await store.snoozeReminder(clientId, parsed.id, durationMs);
        if (!reminder) {
          return { ok: false, error: `Reminder not found or not snoozable: ${parsed.id}` };
        }
        return {
          ok: true,
          output: toJsonOutput({ action: "snooze", reminder: formatReminder(reminder) }),
          meta: { action: "snooze", reminderId: reminder.id, durationMs },
        };
      }

      const timezone = resolveTimeZone(parsed.timezone);
      const instructionSeed = parsed.instruction ?? parsed.message ?? parsed.title ?? "";
      const instruction = parseInstruction(parsed.instruction ?? parsed.message, instructionSeed);
      if (isToolResult(instruction)) return instruction;

      const title = parseTitle(parsed.title, instruction);
      if (isToolResult(title)) return title;

      let scheduleResult: { schedule: PulseReminderSchedule; nextTriggerAt: string } | ToolResult;

      if (parsed.schedule) {
        scheduleResult = parseStructuredSchedule(parsed.schedule, timezone, now);
      } else {
        const expression = parsed.every?.trim() || parsed.when?.trim() || "";
        if (expression.length === 0) {
          return fail("create requires one of: schedule, when, every.");
        }
        const parsedExpression = parsePulseExpression(expression, timezone, now);
        if (!parsedExpression) {
          return fail("unable to parse schedule expression. Try examples like 'tomorrow at 9am' or 'every 1 hour'.");
        }
        scheduleResult = {
          schedule: parsedExpression.schedule,
          nextTriggerAt: parsedExpression.nextTriggerAt,
        };
      }

      if (isToolResult(scheduleResult)) {
        return scheduleResult;
      }

      const reminder = await store.createReminder({
        clientId,
        title,
        instruction,
        timezone,
        schedule: scheduleResult.schedule,
        nextTriggerAt: scheduleResult.nextTriggerAt,
        metadata: parsed.metadata,
        originRunId: context?.runId,
        originSessionId: context?.sessionId,
      });

      return {
        ok: true,
        output: toJsonOutput({ action: "create", reminder: formatReminder(reminder) }),
        meta: {
          action: "create",
          reminderId: reminder.id,
          nextTriggerAt: reminder.nextTriggerAt,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Pulse tool failed",
      };
    }
  },
};

const PULSE_PROMPT_BLOCK = [
  "Pulse calendar/reminder skill is available.",
  "Use pulse when the user asks for reminders, schedules, recurring checks, dates, or times.",
  "Use action=create to save reminders, action=list to view, action=cancel to stop, action=snooze to delay, action=now for current date/time.",
  "When creating reminders, include clear instruction text and timezone when known.",
].join("\n");

const pulseSkill: SkillDefinition = {
  id: "pulse",
  version: "1.0.0",
  description: "Persistent reminder and calendar orchestration for time-based agent tasks.",
  promptBlock: PULSE_PROMPT_BLOCK,
  tools: [pulseTool],
};

export default pulseSkill;
