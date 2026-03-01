import type {
  PulseDailySchedule,
  PulseIntervalSchedule,
  PulseOnceSchedule,
  PulseReminderSchedule,
  PulseWeeklySchedule,
  PulseWeekday,
} from "./types.js";
import {
  addDaysInTimeZone,
  getZonedDateParts,
  type LocalDate,
  resolveTimeZone,
  zonedDateTimeToUtc,
} from "./time.js";

export interface ParsedPulseSchedule {
  schedule: PulseReminderSchedule;
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
    const normalizedHour = hourRaw % 12 + (suffix === "pm" ? 12 : 0);
    return { hour: normalizedHour, minute: minuteRaw };
  }

  if (hourRaw < 0 || hourRaw > 23) {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  }

  return { hour: hourRaw, minute: minuteRaw };
}

function toDateFromParts(parts: { year: number; month: number; day: number }): LocalDate {
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function computeNextDailyOccurrence(schedule: PulseDailySchedule, timezone: string, now: Date): string {
  const nowParts = getZonedDateParts(now, timezone);
  let targetDate = toDateFromParts(nowParts);

  let candidate = zonedDateTimeToUtc(
    {
      ...targetDate,
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  );

  if (candidate.getTime() <= now.getTime()) {
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

function computeNextWeeklyOccurrence(schedule: PulseWeeklySchedule, timezone: string, now: Date): string {
  const nowParts = getZonedDateParts(now, timezone);
  const currentWeekday = nowParts.weekday;

  let dayDelta = (schedule.weekday - currentWeekday + 7) % 7;
  let targetDate = toDateFromParts(nowParts);

  if (dayDelta > 0) {
    targetDate = addDaysInTimeZone(targetDate, dayDelta, timezone);
  }

  let candidate = zonedDateTimeToUtc(
    {
      ...targetDate,
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
    },
    timezone,
  );

  if (candidate.getTime() <= now.getTime()) {
    dayDelta = dayDelta === 0 ? 7 : dayDelta + 7;
    targetDate = addDaysInTimeZone(toDateFromParts(nowParts), dayDelta, timezone);
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

function parseEveryExpression(expression: string, timezone: string, now: Date): ParsedPulseSchedule | null {
  const weeklyMatch = expression.match(/\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/i);
  if (weeklyMatch) {
    const dayLabel = (weeklyMatch[1] ?? "").toLowerCase();
    const weekday = WEEKDAY_LOOKUP[dayLabel];
    if (!weekday) return null;

    const { hour, minute } = parseTimeInText(weeklyMatch[2] ?? "");
    const schedule: PulseWeeklySchedule = {
      kind: "weekly",
      weekday,
      hour,
      minute,
      expression,
    };
    return {
      schedule,
      nextTriggerAt: computeNextWeeklyOccurrence(schedule, timezone, now),
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
      nextTriggerAt: computeNextDailyOccurrence(schedule, timezone, now),
      normalizedExpression: expression,
    };
  }

  const intervalMatch = expression.match(/(?:\bevery\b|\bafter every\b)\s+([a-z0-9]+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)\b/i);
  if (!intervalMatch) return null;

  const value = parseNumberToken(intervalMatch[1] ?? "");
  if (value === null) return null;

  const everyMs = parseDurationToMillis(value, intervalMatch[2] ?? "");
  if (!everyMs) return null;

  const schedule: PulseIntervalSchedule = {
    kind: "interval",
    everyMs,
    anchorAt: now.toISOString(),
    expression,
  };

  return {
    schedule,
    nextTriggerAt: new Date(now.getTime() + everyMs).toISOString(),
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
  let targetDate = toDateFromParts(nowParts);
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
  let targetYear = nowParts.year;
  let targetMonth = nowParts.month + 1;
  if (targetMonth > 12) {
    targetMonth = 1;
    targetYear++;
  }

  const cappedDay = Math.min(requestedDay, daysInMonth(targetYear, targetMonth));
  const { hour, minute } = parseTimeInText(expression);
  const when = zonedDateTimeToUtc(
    {
      year: targetYear,
      month: targetMonth,
      day: cappedDay,
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

  const weekdayLabel = (match[1] ?? "").toLowerCase();
  const weekday = WEEKDAY_LOOKUP[weekdayLabel];
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
    parseEveryExpression(lowered, timezone, nowInput) ??
    parseRelativeExpression(lowered, nowInput) ??
    parseTomorrowTodayExpression(lowered, timezone, nowInput) ??
    parseNextMonthExpression(lowered, timezone, nowInput) ??
    parseNextWeekdayExpression(lowered, timezone, nowInput) ??
    parseIsoLikeExpression(expression, timezone)
  );
}

export function computeNextTriggerForSchedule(
  schedule: PulseReminderSchedule,
  timezoneInput: string,
  nowInput: Date,
  currentScheduledFor?: string,
): string | null {
  const timezone = resolveTimeZone(timezoneInput);
  if (schedule.kind === "once") {
    if (currentScheduledFor) return null;
    return schedule.at;
  }

  if (schedule.kind === "interval") {
    const baseMillis = currentScheduledFor
      ? Date.parse(currentScheduledFor)
      : Date.parse(schedule.anchorAt);
    if (!Number.isFinite(baseMillis)) {
      return new Date(nowInput.getTime() + schedule.everyMs).toISOString();
    }
    let next = baseMillis + schedule.everyMs;
    while (next <= nowInput.getTime()) {
      next += schedule.everyMs;
    }
    return new Date(next).toISOString();
  }

  if (schedule.kind === "daily") {
    return computeNextDailyOccurrence(schedule, timezone, nowInput);
  }

  return computeNextWeeklyOccurrence(schedule, timezone, nowInput);
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
