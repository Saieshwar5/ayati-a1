import type { SessionRotationReason } from "../memory/types.js";

export interface RotationPolicyConfig {
  prepareHandoffContextPercent: number;
  rotateContextPercent: number;
  dailyCutoverHourLocal: number;
  fallbackTimezone: string;
}

export type RotationReason = SessionRotationReason;

export interface EvaluateSessionRotationInput {
  now: Date;
  contextPercent: number;
  sessionStartedAt?: string | null;
  timezone?: string | null;
  pendingRotationReason?: RotationReason | null;
  config?: Partial<RotationPolicyConfig>;
}

export interface EvaluateSessionRotationResult {
  rotate: boolean;
  reason?: RotationReason;
  timezone: string;
  sessionDayKey: string | null;
  currentDayKey: string;
}

export const DEFAULT_ROTATION_POLICY_CONFIG: RotationPolicyConfig = {
  prepareHandoffContextPercent: 50,
  rotateContextPercent: 70,
  dailyCutoverHourLocal: 1,
  fallbackTimezone: "Asia/Kolkata",
};

export function evaluateSessionRotation(input: EvaluateSessionRotationInput): EvaluateSessionRotationResult {
  const cfg = { ...DEFAULT_ROTATION_POLICY_CONFIG, ...(input.config ?? {}) };
  const timezone = resolveRotationTimezone(input.timezone, cfg);
  const sessionDayKey = getLogicalDayKey(input.sessionStartedAt ? new Date(input.sessionStartedAt) : null, timezone, cfg);
  const currentDayKey = getLogicalDayKey(input.now, timezone, cfg);

  if (sessionDayKey && sessionDayKey !== currentDayKey) {
    return {
      rotate: true,
      reason: "daily_cutover",
      timezone,
      sessionDayKey,
      currentDayKey,
    };
  }

  if (input.pendingRotationReason) {
    return {
      rotate: true,
      reason: input.pendingRotationReason,
      timezone,
      sessionDayKey,
      currentDayKey,
    };
  }

  if (shouldRotateSessionForContext(input.contextPercent, cfg)) {
    return {
      rotate: true,
      reason: "context_threshold",
      timezone,
      sessionDayKey,
      currentDayKey,
    };
  }

  return {
    rotate: false,
    timezone,
    sessionDayKey,
    currentDayKey,
  };
}

export function shouldPrepareSessionHandoff(
  contextPercent: number,
  config: RotationPolicyConfig = DEFAULT_ROTATION_POLICY_CONFIG,
): boolean {
  return contextPercent >= config.prepareHandoffContextPercent;
}

export function shouldRotateSessionForContext(
  contextPercent: number,
  config: RotationPolicyConfig = DEFAULT_ROTATION_POLICY_CONFIG,
): boolean {
  return contextPercent >= config.rotateContextPercent;
}

export function resolveRotationTimezone(
  timezone: string | null | undefined,
  config: RotationPolicyConfig = DEFAULT_ROTATION_POLICY_CONFIG,
): string {
  const candidate = typeof timezone === "string" ? timezone.trim() : "";
  if (!candidate) {
    return config.fallbackTimezone;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return config.fallbackTimezone;
  }
}

export function getLogicalDayKey(
  value: Date | null,
  timezone: string,
  config: RotationPolicyConfig = DEFAULT_ROTATION_POLICY_CONFIG,
): string {
  const date = value ?? new Date(0);
  const parts = toLocalDateParts(date, timezone);
  const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));

  if (parts.hour < config.dailyCutoverHourLocal) {
    utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  }

  const year = utcDate.getUTCFullYear();
  const month = String(utcDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utcDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toLocalDateParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(fields["year"] ?? 1970),
    month: Number(fields["month"] ?? 1),
    day: Number(fields["day"] ?? 1),
    hour: Number(fields["hour"] ?? 0),
  };
}
