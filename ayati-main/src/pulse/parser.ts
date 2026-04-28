import type {
  PulseDailySchedule,
  PulseDurationUnit,
  PulseIntervalSchedule,
  PulseMonthlySchedule,
  PulseOnceSchedule,
  PulsePreviewOccurrence,
  PulseSchedule,
  PulseWeeklySchedule,
  PulseWeekday,
  PulseYearlySchedule,
} from "./types.js";
import {
  addDaysInTimeZone,
  addMonthsToLocalDate,
  addYearsToLocalDate,
  daysInMonth,
  getZonedDateParts,
  resolveTimeZone,
  toDateLabel,
  toTimeLabel,
  weekdayName,
  zonedDateTimeToUtc,
} from "./time.js";

export interface ParsedPulseSchedule {
  schedule: PulseSchedule;
  nextTriggerAt: string;
  normalizedExpression: string;
}

interface ParsedTime {
  hour: number;
  minute: number;
}

const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const WEEKDAY_LOOKUP: Record<string, PulseWeekday> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const MONTH_LOOKUP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
};

function parseNumberToken(raw: string): number | null {
  const token = raw.trim().toLowerCase();
  if (token.length === 0) return null;
  if (/^\d+$/.test(token)) {
    const parsed = Number(token);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (NUMBER_WORDS[token] !== undefined) {
    return NUMBER_WORDS[token] ?? null;
  }
  return null;
}

function parseDurationToMillis(value: number, unitRaw: string): number | null {
  const unit = unitRaw.toLowerCase();
  if (value <= 0) return null;

  if (unit === "minute" || unit === "minutes" || unit === "min" || unit === "mins") {
    return value * MINUTE_MS;
  }
  if (unit === "hour" || unit === "hours" || unit === "hr" || unit === "hrs") {
    return value * HOUR_MS;
  }
  if (unit === "day" || unit === "days") {
    return value * DAY_MS;
  }
  if (unit === "week" || unit === "weeks") {
    return value * WEEK_MS;
  }
  return null;
}

export function normalizePulseDurationUnit(raw: string): PulseDurationUnit | null {
  const unit = raw.trim().toLowerCase();
  if (unit === "minute" || unit === "minutes" || unit === "min" || unit === "mins") return "minute";
  if (unit === "hour" || unit === "hours" || unit === "hr" || unit === "hrs") return "hour";
  if (unit === "day" || unit === "days") return "day";
  if (unit === "week" || unit === "weeks") return "week";
  return null;
}

export function pulseDurationToMillis(value: number, unit: PulseDurationUnit): number | null {
  return parseDurationToMillis(value, unit);
}

export function pulseIntervalMsToValueUnit(everyMs: number): { value: number; unit: PulseDurationUnit } | null {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return null;
  const normalized = Math.trunc(everyMs);
  const units: Array<{ unit: PulseDurationUnit; size: number }> = [
    { unit: "week", size: WEEK_MS },
    { unit: "day", size: DAY_MS },
    { unit: "hour", size: HOUR_MS },
    { unit: "minute", size: MINUTE_MS },
  ];
  for (const entry of units) {
    if (normalized % entry.size === 0) {
      const value = normalized / entry.size;
      if (value > 0) {
        return { value, unit: entry.unit };
      }
    }
  }
  return null;
}

function parseTimeInText(text: string): ParsedTime {
  const withAt = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const withColon = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  const withMeridiem = text.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  if (!withAt && !withColon && !withMeridiem) {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  }

  const match = withAt ?? withColon ?? withMeridiem;
  if (!match) {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  }

  const isMeridiemOnly = withMeridiem !== null && withAt === null && withColon === null;
  const hourRaw = Number(match[1] ?? "0");
  const minuteRaw = isMeridiemOnly ? 0 : Number(match[2] ?? "0");
  const suffixValue = isMeridiemOnly ? match[2] : match[3];
  const suffix = typeof suffixValue === "string" ? suffixValue.toLowerCase() : "";

  if (!Number.isFinite(hourRaw) || !Number.isFinite(minuteRaw) || minuteRaw < 0 || minuteRaw > 59) {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  }

  if (suffix === "am" || suffix === "pm") {
    if (hourRaw < 1 || hourRaw > 12) {
      return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
    }
    return {
      hour: hourRaw % 12 + (suffix === "pm" ? 12 : 0),
      minute: minuteRaw,
    };
  }

  if (hourRaw < 0 || hourRaw > 23) {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  }

  return { hour: hourRaw, minute: minuteRaw };
}

function normalizeWeekdays(schedule: PulseWeeklySchedule): PulseWeekday[] {
  const weekdays = schedule.weekdays?.length
    ? schedule.weekdays
    : schedule.weekday !== undefined
      ? [schedule.weekday]
      : [];
  const deduped = Array.from(new Set(weekdays.filter((entry) => entry >= 1 && entry <= 7)));
  deduped.sort((a, b) => a - b);
  return deduped.length > 0 ? deduped : [1];
}

function nextOnce(schedule: PulseOnceSchedule, after: Date): string | null {
  const atMillis = Date.parse(schedule.at);
  if (!Number.isFinite(atMillis)) return null;
  return atMillis > after.getTime() ? new Date(atMillis).toISOString() : null;
}

function nextInterval(schedule: PulseIntervalSchedule, after: Date): string | null {
  const anchorMillis = Date.parse(schedule.anchorAt);
  if (!Number.isFinite(anchorMillis)) {
    return new Date(after.getTime() + schedule.everyMs).toISOString();
  }

  const firstMillis = anchorMillis + schedule.everyMs;
  if (after.getTime() < firstMillis) {
    return new Date(firstMillis).toISOString();
  }

  const steps = Math.floor((after.getTime() - anchorMillis) / schedule.everyMs) + 1;
  const nextMillis = anchorMillis + (Math.max(1, steps) * schedule.everyMs);
  return new Date(nextMillis).toISOString();
}

function nextDaily(schedule: PulseDailySchedule, timezone: string, after: Date): string {
  const afterParts = getZonedDateParts(after, timezone);
  let targetDate = {
    year: afterParts.year,
    month: afterParts.month,
    day: afterParts.day,
  };

  let candidate = zonedDateTimeToUtc(
    {
      ...targetDate,
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  );

  if (candidate.getTime() <= after.getTime()) {
    targetDate = addDaysInTimeZone(targetDate, 1, timezone);
    candidate = zonedDateTimeToUtc(
      {
        ...targetDate,
        hour: schedule.hour,
        minute: schedule.minute,
        second: 0,
      },
      timezone,
    );
  }

  return candidate.toISOString();
}

function nextWeekly(schedule: PulseWeeklySchedule, timezone: string, after: Date): string {
  const weekdays = normalizeWeekdays(schedule);
  const afterParts = getZonedDateParts(after, timezone);
  const baseDate = {
    year: afterParts.year,
    month: afterParts.month,
    day: afterParts.day,
  };

  for (let offset = 0; offset <= 14; offset++) {
    const targetDate = addDaysInTimeZone(baseDate, offset, timezone);
    const candidateWeekday = getZonedDateParts(
      zonedDateTimeToUtc(
        {
          ...targetDate,
          hour: 12,
          minute: 0,
          second: 0,
        },
        timezone,
      ),
      timezone,
    ).weekday;
    if (!weekdays.includes(candidateWeekday)) {
      continue;
    }

    const candidate = zonedDateTimeToUtc(
      {
        ...targetDate,
        hour: schedule.hour,
        minute: schedule.minute,
        second: 0,
      },
      timezone,
    );
    if (candidate.getTime() > after.getTime()) {
      return candidate.toISOString();
    }
  }

  return zonedDateTimeToUtc(
    {
      ...addDaysInTimeZone(baseDate, 7, timezone),
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  ).toISOString();
}

function nextMonthly(schedule: PulseMonthlySchedule, timezone: string, after: Date): string {
  const afterParts = getZonedDateParts(after, timezone);
  let targetDate = {
    year: afterParts.year,
    month: afterParts.month,
    day: Math.min(schedule.day, daysInMonth(afterParts.year, afterParts.month)),
  };

  let candidate = zonedDateTimeToUtc(
    {
      ...targetDate,
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  );

  if (candidate.getTime() <= after.getTime()) {
    const nextMonth = addMonthsToLocalDate(
      { year: afterParts.year, month: afterParts.month, day: 1 },
      1,
    );
    targetDate = {
      year: nextMonth.year,
      month: nextMonth.month,
      day: Math.min(schedule.day, daysInMonth(nextMonth.year, nextMonth.month)),
    };
    candidate = zonedDateTimeToUtc(
      {
        ...targetDate,
        hour: schedule.hour,
        minute: schedule.minute,
        second: 0,
      },
      timezone,
    );
  }

  return candidate.toISOString();
}

function nextYearly(schedule: PulseYearlySchedule, timezone: string, after: Date): string {
  const afterParts = getZonedDateParts(after, timezone);
  let targetYear = afterParts.year;
  let targetDate = {
    year: targetYear,
    month: schedule.month,
    day: Math.min(schedule.day, daysInMonth(targetYear, schedule.month)),
  };

  let candidate = zonedDateTimeToUtc(
    {
      ...targetDate,
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  );

  if (candidate.getTime() <= after.getTime()) {
    targetYear += 1;
    targetDate = {
      year: targetYear,
      month: schedule.month,
      day: Math.min(schedule.day, daysInMonth(targetYear, schedule.month)),
    };
    candidate = zonedDateTimeToUtc(
      {
        ...targetDate,
        hour: schedule.hour,
        minute: schedule.minute,
        second: 0,
      },
      timezone,
    );
  }

  return candidate.toISOString();
}

function latestIntervalOnOrBefore(schedule: PulseIntervalSchedule, now: Date): string | null {
  const anchorMillis = Date.parse(schedule.anchorAt);
  if (!Number.isFinite(anchorMillis)) return null;
  const firstMillis = anchorMillis + schedule.everyMs;
  if (now.getTime() < firstMillis) return null;
  const steps = Math.floor((now.getTime() - anchorMillis) / schedule.everyMs);
  if (steps < 1) return null;
  return new Date(anchorMillis + (steps * schedule.everyMs)).toISOString();
}

function latestDailyOnOrBefore(schedule: PulseDailySchedule, timezone: string, now: Date): string {
  const nowParts = getZonedDateParts(now, timezone);
  let targetDate = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };

  let candidate = zonedDateTimeToUtc(
    {
      ...targetDate,
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  );
  if (candidate.getTime() > now.getTime()) {
    targetDate = addDaysInTimeZone(targetDate, -1, timezone);
    candidate = zonedDateTimeToUtc(
      {
        ...targetDate,
        hour: schedule.hour,
        minute: schedule.minute,
        second: 0,
      },
      timezone,
    );
  }
  return candidate.toISOString();
}

function latestWeeklyOnOrBefore(schedule: PulseWeeklySchedule, timezone: string, now: Date): string {
  const weekdays = normalizeWeekdays(schedule);
  const nowParts = getZonedDateParts(now, timezone);
  const baseDate = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };

  for (let offset = 0; offset <= 14; offset++) {
    const targetDate = addDaysInTimeZone(baseDate, -offset, timezone);
    const candidateWeekday = getZonedDateParts(
      zonedDateTimeToUtc(
        {
          ...targetDate,
          hour: 12,
          minute: 0,
          second: 0,
        },
        timezone,
      ),
      timezone,
    ).weekday;
    if (!weekdays.includes(candidateWeekday)) {
      continue;
    }
    const candidate = zonedDateTimeToUtc(
      {
        ...targetDate,
        hour: schedule.hour,
        minute: schedule.minute,
        second: 0,
      },
      timezone,
    );
    if (candidate.getTime() <= now.getTime()) {
      return candidate.toISOString();
    }
  }

  return zonedDateTimeToUtc(
    {
      ...addDaysInTimeZone(baseDate, -7, timezone),
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  ).toISOString();
}

function latestMonthlyOnOrBefore(schedule: PulseMonthlySchedule, timezone: string, now: Date): string {
  const nowParts = getZonedDateParts(now, timezone);
  let year = nowParts.year;
  let month = nowParts.month;
  let candidate = zonedDateTimeToUtc(
    {
      year,
      month,
      day: Math.min(schedule.day, daysInMonth(year, month)),
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  );

  if (candidate.getTime() > now.getTime()) {
    const previousMonth = addMonthsToLocalDate({ year, month, day: 1 }, -1);
    year = previousMonth.year;
    month = previousMonth.month;
    candidate = zonedDateTimeToUtc(
      {
        year,
        month,
        day: Math.min(schedule.day, daysInMonth(year, month)),
        hour: schedule.hour,
        minute: schedule.minute,
        second: 0,
      },
      timezone,
    );
  }

  return candidate.toISOString();
}

function latestYearlyOnOrBefore(schedule: PulseYearlySchedule, timezone: string, now: Date): string {
  const nowParts = getZonedDateParts(now, timezone);
  let year = nowParts.year;
  let candidate = zonedDateTimeToUtc(
    {
      year,
      month: schedule.month,
      day: Math.min(schedule.day, daysInMonth(year, schedule.month)),
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  );

  if (candidate.getTime() > now.getTime()) {
    year -= 1;
    candidate = zonedDateTimeToUtc(
      {
        year,
        month: schedule.month,
        day: Math.min(schedule.day, daysInMonth(year, schedule.month)),
        hour: schedule.hour,
        minute: schedule.minute,
        second: 0,
      },
      timezone,
    );
  }

  return candidate.toISOString();
}

export function computeNextOccurrenceAfter(
  schedule: PulseSchedule,
  timezoneInput: string | undefined,
  afterInput: Date | string,
): string | null {
  const timezone = resolveTimeZone(timezoneInput);
  const after = typeof afterInput === "string" ? new Date(afterInput) : afterInput;
  if (Number.isNaN(after.getTime())) {
    return null;
  }

  if (schedule.kind === "once") {
    return nextOnce(schedule, after);
  }
  if (schedule.kind === "interval") {
    return nextInterval(schedule, after);
  }
  if (schedule.kind === "daily") {
    return nextDaily(schedule, timezone, after);
  }
  if (schedule.kind === "weekly") {
    return nextWeekly(schedule, timezone, after);
  }
  if (schedule.kind === "monthly") {
    return nextMonthly(schedule, timezone, after);
  }
  return nextYearly(schedule, timezone, after);
}

export function computeLatestDueAtOrBefore(
  schedule: PulseSchedule,
  timezoneInput: string | undefined,
  nowInput: Date,
): string | null {
  const timezone = resolveTimeZone(timezoneInput);
  if (schedule.kind === "once") {
    const atMillis = Date.parse(schedule.at);
    if (!Number.isFinite(atMillis) || atMillis > nowInput.getTime()) {
      return null;
    }
    return new Date(atMillis).toISOString();
  }
  if (schedule.kind === "interval") {
    return latestIntervalOnOrBefore(schedule, nowInput);
  }
  if (schedule.kind === "daily") {
    return latestDailyOnOrBefore(schedule, timezone, nowInput);
  }
  if (schedule.kind === "weekly") {
    return latestWeeklyOnOrBefore(schedule, timezone, nowInput);
  }
  if (schedule.kind === "monthly") {
    return latestMonthlyOnOrBefore(schedule, timezone, nowInput);
  }
  return latestYearlyOnOrBefore(schedule, timezone, nowInput);
}

export function previewPulseOccurrences(
  schedule: PulseSchedule | null,
  timezoneInput: string | undefined,
  nowInput: Date,
  count = 5,
  startAtUtc?: string | null,
): PulsePreviewOccurrence[] {
  const timezone = resolveTimeZone(timezoneInput);
  const safeCount = Math.max(0, Math.min(50, Math.trunc(count)));
  const results: PulsePreviewOccurrence[] = [];

  if (safeCount === 0) {
    return results;
  }

  if (!schedule) {
    if (!startAtUtc) {
      return results;
    }
    const parts = getZonedDateParts(new Date(startAtUtc), timezone);
    return [{
      index: 1,
      scheduledForUtc: new Date(startAtUtc).toISOString(),
      timezone,
      localDate: toDateLabel(parts),
      localTime: toTimeLabel(parts),
      weekday: weekdayName(parts.weekday),
    }];
  }

  let cursor = new Date(nowInput.getTime() - 1);
  for (let index = 1; index <= safeCount; index++) {
    const next = computeNextOccurrenceAfter(schedule, timezone, cursor);
    if (!next) {
      break;
    }
    const parts = getZonedDateParts(new Date(next), timezone);
    results.push({
      index,
      scheduledForUtc: next,
      timezone,
      localDate: toDateLabel(parts),
      localTime: toTimeLabel(parts),
      weekday: weekdayName(parts.weekday),
    });
    cursor = new Date(next);
  }

  return results;
}

function parseMonthToken(raw: string): number | null {
  const normalized = raw.trim().toLowerCase();
  if (MONTH_LOOKUP[normalized] !== undefined) {
    return MONTH_LOOKUP[normalized] ?? null;
  }
  const numeric = Number(normalized);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 12) {
    return null;
  }
  return numeric;
}

function parseEveryExpression(expression: string, timezone: string, now: Date): ParsedPulseSchedule | null {
  const weeklyMatch = expression.match(/\bevery(?: week)?(?: on)?\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/i);
  if (weeklyMatch) {
    const weekday = WEEKDAY_LOOKUP[(weeklyMatch[1] ?? "").toLowerCase()];
    if (!weekday) return null;
    const { hour, minute } = parseTimeInText(weeklyMatch[2] ?? "");
    const schedule: PulseWeeklySchedule = {
      kind: "weekly",
      weekday,
      weekdays: [weekday],
      hour,
      minute,
      expression,
    };
    return {
      schedule,
      nextTriggerAt: computeNextOccurrenceAfter(schedule, timezone, now) ?? now.toISOString(),
      normalizedExpression: expression,
    };
  }

  const dailyMatch = expression.match(/\bevery\s+day(?:\s+at\s+(.+))?$/i);
  if (dailyMatch) {
    const { hour, minute } = parseTimeInText(dailyMatch[1] ?? "");
    const schedule: PulseDailySchedule = {
      kind: "daily",
      hour,
      minute,
      expression,
    };
    return {
      schedule,
      nextTriggerAt: computeNextOccurrenceAfter(schedule, timezone, now) ?? now.toISOString(),
      normalizedExpression: expression,
    };
  }

  const monthlyMatch = expression.match(/\bevery\s+month(?:\s+on)?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+at\s+(.+))?$/i);
  if (monthlyMatch) {
    const day = Number(monthlyMatch[1]);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    const { hour, minute } = parseTimeInText(monthlyMatch[2] ?? "");
    const schedule: PulseMonthlySchedule = {
      kind: "monthly",
      day,
      hour,
      minute,
      expression,
    };
    return {
      schedule,
      nextTriggerAt: computeNextOccurrenceAfter(schedule, timezone, now) ?? now.toISOString(),
      normalizedExpression: expression,
    };
  }

  const yearlyNameMatch = expression.match(/\bevery\s+year(?:\s+on)?\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+at\s+(.+))?$/i);
  if (yearlyNameMatch) {
    const month = parseMonthToken(yearlyNameMatch[1] ?? "");
    const day = Number(yearlyNameMatch[2]);
    if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;
    const { hour, minute } = parseTimeInText(yearlyNameMatch[3] ?? "");
    const schedule: PulseYearlySchedule = {
      kind: "yearly",
      month,
      day,
      hour,
      minute,
      expression,
    };
    return {
      schedule,
      nextTriggerAt: computeNextOccurrenceAfter(schedule, timezone, now) ?? now.toISOString(),
      normalizedExpression: expression,
    };
  }

  const yearlyNumericMatch = expression.match(/\bevery\s+year(?:\s+on)?\s+(\d{1,2})\/(\d{1,2})(?:\s+at\s+(.+))?$/i);
  if (yearlyNumericMatch) {
    const month = Number(yearlyNumericMatch[1]);
    const day = Number(yearlyNumericMatch[2]);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) {
      return null;
    }
    const { hour, minute } = parseTimeInText(yearlyNumericMatch[3] ?? "");
    const schedule: PulseYearlySchedule = {
      kind: "yearly",
      month,
      day,
      hour,
      minute,
      expression,
    };
    return {
      schedule,
      nextTriggerAt: computeNextOccurrenceAfter(schedule, timezone, now) ?? now.toISOString(),
      normalizedExpression: expression,
    };
  }

  const intervalMatch = expression.match(/(?:\bevery\b|\bafter every\b)\s+([a-z0-9]+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)\b/i);
  if (!intervalMatch) {
    return null;
  }

  const value = parseNumberToken(intervalMatch[1] ?? "");
  if (value === null) return null;

  const everyMs = parseDurationToMillis(value, intervalMatch[2] ?? "");
  if (!everyMs) return null;
  const unit = normalizePulseDurationUnit(intervalMatch[2] ?? "");
  if (!unit) return null;

  const schedule: PulseIntervalSchedule = {
    kind: "interval",
    everyMs,
    value,
    unit,
    anchorAt: now.toISOString(),
    expression,
  };

  return {
    schedule,
    nextTriggerAt: nextInterval(schedule, now) ?? new Date(now.getTime() + everyMs).toISOString(),
    normalizedExpression: expression,
  };
}

function parseRelativeExpression(expression: string, now: Date): ParsedPulseSchedule | null {
  const match = expression.match(/\b(?:in|after)\s+([a-z0-9]+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)\b/i);
  if (!match) return null;

  const value = parseNumberToken(match[1] ?? "");
  if (value === null) return null;
  const ms = parseDurationToMillis(value, match[2] ?? "");
  if (!ms) return null;

  const when = new Date(now.getTime() + ms).toISOString();
  const schedule: PulseOnceSchedule = {
    kind: "once",
    at: when,
    expression,
  };
  return {
    schedule,
    nextTriggerAt: when,
    normalizedExpression: expression,
  };
}

function parseTomorrowTodayExpression(expression: string, timezone: string, now: Date): ParsedPulseSchedule | null {
  const lowered = expression.toLowerCase();
  const includesTomorrow = lowered.includes("tomorrow");
  const includesToday = lowered.includes("today");
  if (!includesTomorrow && !includesToday) return null;

  const nowParts = getZonedDateParts(now, timezone);
  let targetDate = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };
  if (includesTomorrow) {
    targetDate = addDaysInTimeZone(targetDate, 1, timezone);
  }

  const { hour, minute } = parseTimeInText(expression);
  const when = zonedDateTimeToUtc(
    {
      ...targetDate,
      hour,
      minute,
      second: 0,
    },
    timezone,
  ).toISOString();
  const schedule: PulseOnceSchedule = {
    kind: "once",
    at: when,
    expression,
  };
  return {
    schedule,
    nextTriggerAt: when,
    normalizedExpression: expression,
  };
}

function parseNextMonthExpression(expression: string, timezone: string, now: Date): ParsedPulseSchedule | null {
  const match = expression.match(/(?:\bafter\s+)?\bnext month\s+(\d{1,2})\b/i);
  if (!match) return null;

  const requestedDay = Number(match[1]);
  if (!Number.isInteger(requestedDay) || requestedDay <= 0 || requestedDay > 31) {
    return null;
  }

  const nowParts = getZonedDateParts(now, timezone);
  const nextMonth = addMonthsToLocalDate(
    {
      year: nowParts.year,
      month: nowParts.month,
      day: 1,
    },
    1,
  );
  const { hour, minute } = parseTimeInText(expression);
  const when = zonedDateTimeToUtc(
    {
      year: nextMonth.year,
      month: nextMonth.month,
      day: Math.min(requestedDay, daysInMonth(nextMonth.year, nextMonth.month)),
      hour,
      minute,
      second: 0,
    },
    timezone,
  ).toISOString();

  const schedule: PulseOnceSchedule = {
    kind: "once",
    at: when,
    expression,
  };
  return {
    schedule,
    nextTriggerAt: when,
    normalizedExpression: expression,
  };
}

function parseNextWeekdayExpression(expression: string, timezone: string, now: Date): ParsedPulseSchedule | null {
  const match = expression.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/i);
  if (!match) return null;

  const weekday = WEEKDAY_LOOKUP[(match[1] ?? "").toLowerCase()];
  if (!weekday) return null;

  const nowParts = getZonedDateParts(now, timezone);
  const currentWeekday = nowParts.weekday;
  let dayDelta = (weekday - currentWeekday + 7) % 7;
  if (dayDelta === 0) {
    dayDelta = 7;
  }
  const targetDate = addDaysInTimeZone(
    {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
    },
    dayDelta,
    timezone,
  );
  const { hour, minute } = parseTimeInText(match[2] ?? "");
  const when = zonedDateTimeToUtc(
    {
      ...targetDate,
      hour,
      minute,
      second: 0,
    },
    timezone,
  ).toISOString();
  const schedule: PulseOnceSchedule = {
    kind: "once",
    at: when,
    expression,
  };
  return {
    schedule,
    nextTriggerAt: when,
    normalizedExpression: expression,
  };
}

function parseIsoLikeExpression(expression: string, timezone: string): ParsedPulseSchedule | null {
  const basicDateMatch = expression.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2})(?::(\d{2}))?)?$/);
  if (basicDateMatch) {
    const year = Number(basicDateMatch[1]);
    const month = Number(basicDateMatch[2]);
    const day = Number(basicDateMatch[3]);
    const hour = Number(basicDateMatch[4] ?? `${DEFAULT_HOUR}`);
    const minute = Number(basicDateMatch[5] ?? `${DEFAULT_MINUTE}`);
    const utcDate = zonedDateTimeToUtc(
      {
        year,
        month,
        day,
        hour,
        minute,
        second: 0,
      },
      timezone,
    );
    const at = utcDate.toISOString();
    const schedule: PulseOnceSchedule = {
      kind: "once",
      at,
      expression,
    };
    return {
      schedule,
      nextTriggerAt: at,
      normalizedExpression: expression,
    };
  }

  const parsedMillis = Date.parse(expression);
  if (!Number.isFinite(parsedMillis)) return null;
  const at = new Date(parsedMillis).toISOString();
  const schedule: PulseOnceSchedule = {
    kind: "once",
    at,
    expression,
  };
  return {
    schedule,
    nextTriggerAt: at,
    normalizedExpression: expression,
  };
}

export function parsePulseExpression(rawExpression: string, timezoneInput: string | undefined, nowInput: Date): ParsedPulseSchedule | null {
  const expression = rawExpression.trim();
  if (expression.length === 0) return null;

  const timezone = resolveTimeZone(timezoneInput);
  const lowered = expression.toLowerCase();

  return (
    parseEveryExpression(lowered, timezone, nowInput)
    ?? parseRelativeExpression(lowered, nowInput)
    ?? parseTomorrowTodayExpression(lowered, timezone, nowInput)
    ?? parseNextMonthExpression(lowered, timezone, nowInput)
    ?? parseNextWeekdayExpression(lowered, timezone, nowInput)
    ?? parseIsoLikeExpression(expression, timezone)
  );
}

export function computeNextTriggerForSchedule(
  schedule: PulseSchedule,
  timezoneInput: string,
  nowInput: Date,
  currentScheduledFor?: string,
): string | null {
  if (schedule.kind === "once") {
    return currentScheduledFor ? null : schedule.at;
  }

  const referenceMillis = currentScheduledFor ? Date.parse(currentScheduledFor) : Number.NaN;
  const effectiveAfter = Number.isFinite(referenceMillis)
    ? new Date(Math.max(nowInput.getTime(), referenceMillis))
    : nowInput;
  return computeNextOccurrenceAfter(schedule, timezoneInput, effectiveAfter);
}

export function parseSnoozeDuration(raw: string): number | null {
  const lowered = raw.trim().toLowerCase();
  if (lowered.length === 0) return null;
  const match = lowered.match(/([a-z0-9]+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)\b/);
  if (!match) return null;
  const value = parseNumberToken(match[1] ?? "");
  if (value === null) return null;
  return parseDurationToMillis(value, match[2] ?? "");
}
