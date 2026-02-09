/**
 * Dedicated memory-system debug logger.
 *
 * Every line prints a bright green [MEMORY] prefix so you can filter with:
 *   grep "\[MEMORY\]"
 *
 * Categories:
 *   SESSION  — session open / close / recovery
 *   EVENT    — every event appended (user_message, tool_call, etc.)
 *   TIER     — tier score computation and tier changes
 *   DB       — SQLite writes (summaries, FTS)
 *   DISK     — JSONL appends, large-output files, tool-context writes
 *   SUMMARY  — rolling / final summary generation
 */

const R = "\x1b[0m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const WHITE = "\x1b[37m";

type Category = "SESSION" | "EVENT" | "TIER" | "DB" | "DISK" | "SUMMARY";

const CATEGORY_COLORS: Record<Category, string> = {
  SESSION: MAGENTA,
  EVENT: CYAN,
  TIER: YELLOW,
  DB: RED,
  DISK: WHITE,
  SUMMARY: GREEN,
};

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function memLog(category: Category, message: string, detail?: Record<string, unknown>): void {
  const color = CATEGORY_COLORS[category] ?? WHITE;
  const prefix = `${GREEN}${BOLD}[MEMORY]${R}`;
  const cat = `${color}${category.padEnd(7)}${R}`;
  const time = `${DIM}${ts()}${R}`;

  if (detail) {
    const parts = Object.entries(detail)
      .map(([k, v]) => `${DIM}${k}=${R}${formatValue(v)}`)
      .join(" ");
    console.log(`${prefix} ${time} ${cat} ${message}  ${parts}`);
  } else {
    console.log(`${prefix} ${time} ${cat} ${message}`);
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return `${DIM}null${R}`;
  if (typeof v === "string") {
    if (v.length > 80) return `"${v.slice(0, 77)}..."`;
    return `"${v}"`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

// ── Public API ─────────────────────────────────────────────

export function logSessionOpen(sessionId: string, clientId: string, tier: string): void {
  memLog("SESSION", "▶ Session OPENED", { sessionId: shortId(sessionId), clientId, tier });
}

export function logSessionClose(sessionId: string, reason: string, turnCount: number): void {
  memLog("SESSION", "■ Session CLOSED", { sessionId: shortId(sessionId), reason, turns: turnCount });
}

export function logSessionRestore(sessionId: string, eventCount: number): void {
  memLog("SESSION", "↻ Session RESTORED from JSONL", { sessionId: shortId(sessionId), events: eventCount });
}

export function logSessionExpiredOnRecovery(sessionId: string): void {
  memLog("SESSION", "⚠ Session EXPIRED during recovery", { sessionId: shortId(sessionId) });
}

export function logSessionExpiryCheck(
  sessionId: string,
  expired: boolean,
  idleMin: number,
  hardCapMin: number,
  lastActivity: string,
): void {
  memLog("SESSION", expired ? "⏱ Session EXPIRED" : "✓ Session still active", {
    sessionId: shortId(sessionId),
    expired,
    idleTimeout: `${idleMin}min`,
    hardCap: `${hardCapMin}min`,
    lastActivity,
  });
}

export function logEvent(type: string, sessionId: string, extra?: Record<string, unknown>): void {
  memLog("EVENT", `+ ${type}`, { sessionId: shortId(sessionId), ...extra });
}

export function logTierScore(sessionId: string, score: number, currentTier: string): void {
  memLog("TIER", `Score computed`, { sessionId: shortId(sessionId), score: Math.round(score * 100) / 100, currentTier });
}

export function logTierChange(sessionId: string, from: string, to: string, score: number): void {
  memLog("TIER", `★ Tier CHANGED ${from} → ${to}`, { sessionId: shortId(sessionId), score: Math.round(score * 100) / 100 });
}

export function logDbSummaryWrite(
  sessionId: string,
  summaryType: "rolling" | "final",
  textLength: number,
  keywords: string[],
): void {
  memLog("DB", `💾 Summary WRITTEN to SQLite`, {
    sessionId: shortId(sessionId),
    type: summaryType,
    textLen: textLength,
    keywords: keywords.slice(0, 5).join(", "),
  });
}

export function logDbSummaryLoad(clientId: string, found: boolean, textLength: number): void {
  memLog("DB", `📖 Previous summary LOADED`, { clientId, found, textLen: textLength });
}

export function logDbStart(dbPath: string): void {
  memLog("DB", `🔌 SQLite OPENED`, { path: dbPath });
}

export function logDbStop(): void {
  memLog("DB", `🔌 SQLite CLOSED`);
}

export function logDiskAppendEvent(type: string, sessionId: string, filePath: string): void {
  memLog("DISK", `📝 Event appended to JSONL`, { type, sessionId: shortId(sessionId), file: filePath.split("/").pop() });
}

export function logDiskLargeOutput(toolName: string, outputLen: number, filePath: string): void {
  memLog("DISK", `📦 Large tool output saved`, { toolName, chars: outputLen, file: filePath.split("/").pop() });
}

export function logDiskToolContext(toolName: string, status: string): void {
  memLog("DISK", `📋 Tool context entry appended`, { toolName, status });
}

export function logRollingSummary(sessionId: string, userTurns: number): void {
  memLog("SUMMARY", `📊 Rolling summary at turn ${userTurns}`, { sessionId: shortId(sessionId) });
}

export function logFinalSummary(sessionId: string, textLength: number): void {
  memLog("SUMMARY", `📊 Final summary generated`, { sessionId: shortId(sessionId), textLen: textLength });
}

export function logInitStart(clientId: string): void {
  memLog("SESSION", "🚀 SessionManager.initialize() START", { clientId });
}

export function logInitDone(clientId: string, hasActiveSession: boolean): void {
  memLog("SESSION", "✅ SessionManager.initialize() DONE", { clientId, hasActiveSession });
}

export function logShutdownStart(): void {
  memLog("SESSION", "🛑 SessionManager.shutdown() START");
}

export function logShutdownDone(): void {
  memLog("SESSION", "✅ SessionManager.shutdown() DONE");
}
