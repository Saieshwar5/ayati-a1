import { spawnSync } from "node:child_process";
import type { PulseClockHealth, PulseNowSnapshot, PulseWeekday } from "./types.js";

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: PulseWeekday;
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export interface LocalDateTimeInput extends LocalDate {
  hour: number;
  minute: number;
  second?: number;
}

const DEFAULT_TIMEZONE = "UTC";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_MAP: Record<string, PulseWeekday> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

function toNumber(part: string | undefined): number {
  return Number(part ?? "0");
}

function extractPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const found = parts.find((part) => part.type === type);
  return found?.value ?? "";
}

function toWeekday(value: string): PulseWeekday {
  const normalized = value.trim().toLowerCase();
  return WEEKDAY_MAP[normalized] ?? 1;
}

export function isValidTimeZone(value: string): boolean {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: value });
    formatter.format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(value?: string): string {
  const requested = value?.trim();
  if (requested && isValidTimeZone(requested)) {
    return requested;
  }

  const envTz = process.env["PULSE_TIMEZONE"]?.trim();
  if (envTz && isValidTimeZone(envTz)) {
    return envTz;
  }

  const runtimeTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (runtimeTz && isValidTimeZone(runtimeTz)) {
    return runtimeTz;
  }

  return DEFAULT_TIMEZONE;
}

export function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const weekdayLabel = extractPart(parts, "weekday");

  return {
    year: toNumber(extractPart(parts, "year")),
    month: toNumber(extractPart(parts, "month")),
    day: toNumber(extractPart(parts, "day")),
    hour: toNumber(extractPart(parts, "hour")),
    minute: toNumber(extractPart(parts, "minute")),
    second: toNumber(extractPart(parts, "second")),
    weekday: toWeekday(weekdayLabel),
  };
}

export function zonedDateTimeToUtc(input: LocalDateTimeInput, timeZone: string): Date {
  const second = input.second ?? 0;
  const targetUtcMillis = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    second,
  );

  let guess = targetUtcMillis;
  for (let i = 0; i < 6; i++) {
    const guessParts = getZonedDateParts(new Date(guess), timeZone);
    const guessAsUtcMillis = Date.UTC(
      guessParts.year,
      guessParts.month - 1,
      guessParts.day,
      guessParts.hour,
      guessParts.minute,
      guessParts.second,
    );
    const diff = guessAsUtcMillis - targetUtcMillis;
    if (diff === 0) {
      break;
    }
    guess -= diff;
  }

  return new Date(guess);
}

export function addDaysInTimeZone(date: LocalDate, days: number, timeZone: string): LocalDate {
  if (days === 0) return date;
  const noonUtc = zonedDateTimeToUtc(
    {
      year: date.year,
      month: date.month,
      day: date.day,
      hour: 12,
      minute: 0,
      second: 0,
    },
    timeZone,
  );

  const shifted = new Date(noonUtc.getTime() + (days * DAY_MS));
  const shiftedParts = getZonedDateParts(shifted, timeZone);

  return {
    year: shiftedParts.year,
    month: shiftedParts.month,
    day: shiftedParts.day,
  };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addMonthsToLocalDate(date: LocalDate, months: number): LocalDate {
  const totalMonths = ((date.year * 12) + (date.month - 1)) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  return {
    year,
    month,
    day: Math.min(date.day, daysInMonth(year, month)),
  };
}

export function addYearsToLocalDate(date: LocalDate, years: number): LocalDate {
  const year = date.year + years;
  return {
    year,
    month: date.month,
    day: Math.min(date.day, daysInMonth(year, date.month)),
  };
}

export function toDateLabel(parts: LocalDate): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function toTimeLabel(parts: { hour: number; minute: number; second?: number }): string {
  const seconds = parts.second ?? 0;
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function weekdayName(weekday: PulseWeekday): string {
  const entries = Object.entries(WEEKDAY_MAP);
  for (const [name, value] of entries) {
    if (value === weekday) {
      return name;
    }
  }
  return "monday";
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

export function getNowSnapshot(now: Date, timezoneInput?: string): PulseNowSnapshot {
  const timezone = resolveTimeZone(timezoneInput);
  const parts = getZonedDateParts(now, timezone);
  return {
    nowUtc: now.toISOString(),
    timezone,
    localDate: toDateLabel(parts),
    localTime: toTimeLabel(parts),
    weekday: weekdayName(parts.weekday),
  };
}

export function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = getZonedDateParts(date, timeZone);
  const asUtcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtcMillis - date.getTime()) / 60000);
}

export function getClockHealth(now: Date, timezoneInput?: string): PulseClockHealth {
  const snapshot = getNowSnapshot(now, timezoneInput);
  const diagnostics = getBestEffortClockDiagnostics();
  return {
    ...snapshot,
    epochMs: now.getTime(),
    monotonicMs: Number(process.hrtime.bigint() / BigInt(1_000_000)),
    systemTimeZone: resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    offsetMinutes: getTimeZoneOffsetMinutes(now, snapshot.timezone),
    syncHealthy: diagnostics.syncHealthy,
    diagnostics: diagnostics.details,
  };
}

function getBestEffortClockDiagnostics(): { syncHealthy: boolean | null; details: Record<string, unknown> } {
  const timedatectl = spawnSync("timedatectl", ["show", "--property=NTPSynchronized", "--property=TimeUSec", "--property=Timezone"], {
    encoding: "utf8",
    timeout: 1000,
  });

  if (timedatectl.status === 0) {
    const details: Record<string, unknown> = {};
    for (const line of timedatectl.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.includes("=")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1);
      details[key] = value;
    }
    const ntp = typeof details["NTPSynchronized"] === "string"
      ? String(details["NTPSynchronized"]).toLowerCase() === "yes"
      : null;
    return {
      syncHealthy: ntp,
      details: {
        source: "timedatectl",
        ...details,
      },
    };
  }

  return {
    syncHealthy: null,
    details: {
      source: "runtime_only",
      reason: timedatectl.error?.message ?? timedatectl.stderr?.trim() ?? "timedatectl_unavailable",
    },
  };
}
