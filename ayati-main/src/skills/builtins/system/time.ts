export interface SystemTimeSnapshot {
  nowUtc: string;
  timezone: string;
  localDate: string;
  localTime: string;
  weekday: string;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

function extractPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function toNumber(value: string): number {
  return Number(value || "0");
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
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
  }).formatToParts(date);

  return {
    year: toNumber(extractPart(parts, "year")),
    month: toNumber(extractPart(parts, "month")),
    day: toNumber(extractPart(parts, "day")),
    hour: toNumber(extractPart(parts, "hour")),
    minute: toNumber(extractPart(parts, "minute")),
    second: toNumber(extractPart(parts, "second")),
    weekday: extractPart(parts, "weekday").toLowerCase(),
  };
}

function formatDate(parts: ZonedDateParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function formatTime(parts: ZonedDateParts): string {
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
}

export function getNowSnapshot(now: Date, timezone: string): SystemTimeSnapshot {
  const parts = getZonedDateParts(now, timezone);
  return {
    nowUtc: now.toISOString(),
    timezone,
    localDate: formatDate(parts),
    localTime: formatTime(parts),
    weekday: parts.weekday,
  };
}

export function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = getZonedDateParts(date, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((localAsUtc - date.getTime()) / 60_000);
}
