import { formatConversationTurnSpeaker } from "../memory/conversation-turn-format.js";
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
      message: "SYSTEM: Context is critically full (>=95%). The engine must rotate the session before more work continues.",
    };
  }

  if (contextPercent >= 85) {
    return {
      level: "critical",
      message:
        "CRITICAL: Context usage is very high. Automatic rotation is pending, and the engine will carry a finalized handoff into the next session.",
    };
  }

  if (contextPercent >= 70) {
    return {
      level: "warning",
      message:
        "WARNING: Context usage has reached the rotation band. Finish the current run normally; the engine will rotate on the next run using the prepared handoff.",
    };
  }

  if (contextPercent >= 50) {
    return {
      level: "info",
      message:
        "INFO: Context usage is moderate. Background handoff preparation is active so continuity stays ready if the session needs to rotate.",
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
    return `${formatConversationTurnSpeaker(t)}: ${truncated}`;
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
