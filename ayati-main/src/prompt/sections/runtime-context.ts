import type { PromptRuntimeContext } from "../types.js";

export function renderRuntimeContextSection(context: PromptRuntimeContext | null | undefined): string {
  if (!context) return "";

  return [
    "# Runtime Context",
    "",
    `- now_utc: ${context.nowUtc}`,
    `- timezone: ${context.timezone}`,
    `- local_date: ${context.localDate}`,
    `- local_time: ${context.localTime}`,
    `- weekday: ${context.weekday}`,
    "",
    "Treat this as the current date, time, day, and timezone for this run. Interpret today, tomorrow, yesterday, schedules, reminders, and deadlines using this runtime context.",
  ].join("\n");
}
