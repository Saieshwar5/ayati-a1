import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LoopState, ActOutput, ActToolCallRecord, VerifyOutput } from "./types.js";

type PersistedLoopState = Omit<LoopState, "sessionHistory" | "recentRunLedgers" | "activeSessionAttachments" | "openFeedbacks" | "recentSystemActivity">;

export function initRunDirectory(dataDir: string, runId: string): string {
  const runPath = join(dataDir, "runs", runId);
  mkdirSync(join(runPath, "steps"), { recursive: true });
  return runPath;
}

export function writeJSON(runPath: string, filename: string, data: unknown): void {
  const filePath = join(runPath, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function writeState(runPath: string, state: LoopState): void {
  const {
    sessionHistory: _sessionHistory,
    recentRunLedgers: _recentRunLedgers,
    activeSessionAttachments: _activeSessionAttachments,
    openFeedbacks: _openFeedbacks,
    recentSystemActivity: _recentSystemActivity,
    ...persisted
  } = state;
  const persistedState: PersistedLoopState = persisted;
  writeJSON(runPath, "state.json", persistedState);
}

export function writeStepMarkdown(runPath: string, filename: string, content: string): void {
  const filePath = join(runPath, filename);
  writeFileSync(filePath, content, "utf-8");
}

export function readState(runPath: string): Partial<LoopState> | null {
  const filePath = join(runPath, "state.json");
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<LoopState>;
  if (parsed && typeof parsed === "object") {
    delete (parsed as Record<string, unknown>)["sessionHistory"];
    delete (parsed as Record<string, unknown>)["recentRunLedgers"];
    delete (parsed as Record<string, unknown>)["activeSessionAttachments"];
    delete (parsed as Record<string, unknown>)["openFeedbacks"];
    delete (parsed as Record<string, unknown>)["recentSystemActivity"];
  }
  return parsed;
}

// --- Markdown formatters ---

function summarizeValue(value: unknown, maxLen = 300): string {
  if (typeof value === "string") {
    return value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
  } catch {
    return String(value);
  }
}

export function formatActMarkdown(data: ActOutput): string {
  const lines: string[] = ["# Act Output", ""];

  if (data.toolCalls.length > 0) {
    lines.push("## Tool Calls", "");
    for (let i = 0; i < data.toolCalls.length; i++) {
      const call = data.toolCalls[i]!;
      lines.push(`### Call ${i + 1}: ${call.tool}`, "");
      lines.push("**Input:**", summarizeValue(call.input), "");
      lines.push("**Output:**", summarizeValue(call.output), "");
      if (call.error) {
        lines.push(`**Error:** ${call.error}`, "");
      }
    }
  } else {
    lines.push("## Tool Calls", "", "_No tool calls made._", "");
  }

  if (data.finalText) {
    lines.push("## Final Text", "", data.finalText, "");
  }

  if (data.stoppedEarlyReason) {
    lines.push("## Stop Reason", "", data.stoppedEarlyReason, "");
  }

  return lines.join("\n");
}

function summarizeError(error: string, maxLen = 180): string {
  const compact = error.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

export function formatVerifyMarkdown(data: VerifyOutput, toolCalls: ActToolCallRecord[] = []): string {
  const passCount = toolCalls.filter((call) => !call.error).length;
  const failCount = toolCalls.length - passCount;
  const lines: string[] = [
    "# Verify Output",
    "",
    `- **Passed:** ${data.passed ? "yes" : "no"}`,
    `- **Method:** ${data.method}`,
  ];

  if (toolCalls.length > 0) {
    lines.push("", "## Tool Calls", "");
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      if (call.error) {
        lines.push(`- ${i + 1}. ${call.tool} - fail (${summarizeError(call.error)})`);
      } else {
        lines.push(`- ${i + 1}. ${call.tool} - pass`);
      }
    }
  }

  lines.push("", `- **Tool Summary:** pass=${passCount}, fail=${failCount}`);

  if (data.taskStatusAfter) {
    lines.push(`- **Task Status After:** ${data.taskStatusAfter}`);
  }
  if (data.taskReason && data.taskReason.trim().length > 0) {
    lines.push(`- **Task Reason:** ${summarizeValue(data.taskReason, 220)}`);
  }
  if ((data.taskEvidence ?? []).length > 0) {
    lines.push("", "## Task Evidence", "");
    for (const evidence of data.taskEvidence ?? []) {
      lines.push(`- ${summarizeValue(evidence, 220)}`);
    }
  }

  return lines.join("\n");
}
