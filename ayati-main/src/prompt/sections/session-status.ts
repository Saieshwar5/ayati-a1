import type { SessionStatus } from "../../memory/types.js";
import { computeContextPressure } from "../../ivec/context-pressure.js";

export function renderSessionStatusSection(status: SessionStatus | null): string {
  if (!status) return "";

  const lines = [
    "# Session Status",
    "",
    `- context_usage: ${Math.round(status.contextPercent)}%`,
    `- turns: ${status.turns}`,
    `- session_age: ${status.sessionAgeMinutes}m`,
    `- handoff_state: ${status.handoffPhase}`,
    `- rotation_pending: ${status.pendingRotationReason ?? "none"}`,
  ];

  const pressure = computeContextPressure(status.contextPercent);
  if (pressure.message.length > 0) {
    lines.push("");
    lines.push(pressure.message);
  }

  return lines.join("\n");
}
