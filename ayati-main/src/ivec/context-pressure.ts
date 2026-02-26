import type { ConversationTurn } from "../memory/types.js";

export type PressureLevel = "none" | "info" | "warning" | "critical" | "auto_rotate";

export interface ContextPressureSignal {
  level: PressureLevel;
  message: string;
}

export function computeContextPressure(contextPercent: number): ContextPressureSignal {
  if (contextPercent >= 95) {
    return {
      level: "auto_rotate",
      message: "SYSTEM: Context is full (≥95%). Auto-rotating session now.",
    };
  }

  if (contextPercent >= 85) {
    return {
      level: "critical",
      message:
        "CRITICAL: Context usage is very high. You MUST rotate the session NOW using create_session. " +
        "Include a detailed handoff_summary of what was accomplished and what remains.",
    };
  }

  if (contextPercent >= 70) {
    return {
      level: "warning",
      message:
        "WARNING: Context usage is elevated. Start wrapping up your current task. " +
        "Prepare a handoff summary and rotate the session soon using create_session.",
    };
  }

  if (contextPercent >= 50) {
    return {
      level: "info",
      message:
        "INFO: Context usage is moderate. Be mindful of context limits. " +
        "Consider whether a session rotation will be needed soon.",
    };
  }

  return { level: "none", message: "" };
}

export function buildAutoRotateHandoff(
  turns: ConversationTurn[],
  contextPercent: number,
  previousSummary: string,
): string {
  const recent = turns.slice(-5);
  const turnLines = recent.map((t) => {
    const truncated = t.content.length > 200 ? t.content.slice(0, 200) + "..." : t.content;
    return `[${t.role}]: ${truncated}`;
  });

  const parts: string[] = [
    `Auto-rotated at ${Math.round(contextPercent)}% context.`,
    "",
    "Last conversation:",
    ...turnLines,
  ];

  if (previousSummary.trim().length > 0) {
    parts.push("", `Previous session summary: ${previousSummary.trim()}`);
  }

  return parts.join("\n").slice(0, 1000);
}
