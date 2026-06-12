import type { SessionStatus } from "../../memory/types.js";

export function renderSessionStatusSection(status: SessionStatus | null): string {
  if (!status) return "";

  return [
    "# Session Status",
    "",
    `- session_id: ${status.sessionId}`,
    `- session_date: ${status.sessionDate}`,
    `- session_path: ${status.activeSessionPath}`,
    `- turns: ${status.turns}`,
    `- session_age: ${status.sessionAgeMinutes}m`,
  ].join("\n");
}
