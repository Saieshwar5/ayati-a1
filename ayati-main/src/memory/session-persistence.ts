import { appendFileSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { devWarn } from "../shared/index.js";
import {
  logDbStart,
  logDbStop,
  logDbSummaryWrite,
  logDbSummaryLoad,
  logDiskAppendEvent,
  logDiskLargeOutput,
  logDiskToolContext,
} from "./memory-logger.js";
import type { SessionEvent, ToolContextEntry } from "./session-events.js";
import { serializeEvent, deserializeEvent } from "./session-events.js";
import { InMemorySession } from "./session.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");
const DEFAULT_DB_PATH = resolve(DEFAULT_DATA_DIR, "memory.sqlite");

const LARGE_OUTPUT_THRESHOLD = 2000;

export interface SessionPersistenceOptions {
  dbPath?: string;
  dataDir?: string;
}

export class SessionPersistence {
  private readonly dbPath: string;
  private readonly dataDir: string;
  readonly sessionsDir: string;
  private readonly toolOutputDir: string;
  private readonly toolContextDir: string;
  private db: DatabaseSync | null = null;

  constructor(options?: SessionPersistenceOptions) {
    this.dbPath = options?.dbPath ?? DEFAULT_DB_PATH;
    this.dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.sessionsDir = resolve(this.dataDir, "sessions");
    this.toolOutputDir = resolve(this.dataDir, "tool-output");
    this.toolContextDir = resolve(this.dataDir, "tool-context");
  }

  start(): void {
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.toolOutputDir, { recursive: true });
    mkdirSync(this.toolContextDir, { recursive: true });
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    logDbStart(this.dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        summary_type TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_client_time
        ON session_summaries (client_id, created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        doc_type,
        ref_id UNINDEXED,
        session_id UNINDEXED,
        client_id UNINDEXED,
        content,
        created_at UNINDEXED
      );
    `);
  }

  stop(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    logDbStop();
  }

  appendEvent(event: SessionEvent): void {
    const filePath = resolve(this.sessionsDir, `${event.sessionId}.jsonl`);
    const line = serializeEvent(event);
    appendFileSync(filePath, `${line}\n`, "utf8");
    logDiskAppendEvent(event.type, event.sessionId, filePath);
  }

  getActiveSessionId(): string | null {
    const markerPath = resolve(this.sessionsDir, "active-session.txt");
    try {
      return readFileSync(markerPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  writeActiveSessionMarker(sessionId: string): void {
    const markerPath = resolve(this.sessionsDir, "active-session.txt");
    writeFileSync(markerPath, sessionId, "utf8");
  }

  clearActiveSessionMarker(): void {
    const markerPath = resolve(this.sessionsDir, "active-session.txt");
    try {
      unlinkSync(markerPath);
    } catch {
      // ignore ENOENT
    }
  }

  replaySessionFile(filePath: string): InMemorySession | null {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8").trim();
    } catch {
      return null;
    }

    if (content.length === 0) return null;

    const lines = content.split("\n");
    let session: InMemorySession | null = null;

    for (const line of lines) {
      if (line.trim().length === 0) continue;

      let event: SessionEvent;
      try {
        event = deserializeEvent(line);
      } catch {
        devWarn(`Skipping malformed event line in ${filePath}`);
        continue;
      }

      if (event.type === "session_open") {
        session = new InMemorySession(
          event.sessionId,
          event.clientId,
          event.ts,
          event.tier,
        );
        continue;
      }

      if (!session) continue;

      if (event.type === "session_tier_change") {
        session.tierState = {
          tier: event.toTier,
          hardCapMinutes: event.hardCapMinutes,
          idleTimeoutMinutes: event.idleTimeoutMinutes,
          candidateTier: null,
          candidateHits: 0,
        };
        session.addEntry(event);
      } else if (
        event.type === "user_message" ||
        event.type === "assistant_message" ||
        event.type === "tool_call" ||
        event.type === "tool_result" ||
        event.type === "run_failure"
      ) {
        session.addEntry(event);
      }
    }

    return session;
  }

  loadPreviousSessionSummary(clientId: string): string {
    if (!this.db) return "";

    const row = this.db
      .prepare(
        `SELECT summary_text
         FROM session_summaries
         WHERE client_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(clientId) as { summary_text: string } | undefined;

    const text = row?.summary_text ?? "";
    logDbSummaryLoad(clientId, !!row, text.length);
    return text;
  }

  saveSessionSummary(
    sessionId: string,
    clientId: string,
    summaryType: "rolling" | "final",
    summaryText: string,
    keywords: string[],
    nowIso: string,
  ): void {
    if (!this.db) return;

    const summaryId = crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO session_summaries (
          id, session_id, client_id, summary_type, summary_text, keywords_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(summaryId, sessionId, clientId, summaryType, summaryText, JSON.stringify(keywords), nowIso);

    this.db.prepare("DELETE FROM memory_fts WHERE doc_type = 'summary' AND ref_id = ?").run(summaryId);
    this.db
      .prepare(
        `INSERT INTO memory_fts (doc_type, ref_id, session_id, client_id, content, created_at)
         VALUES ('summary', ?, ?, ?, ?, ?)`,
      )
      .run(summaryId, sessionId, clientId, `${summaryText}\n${keywords.join(" ")}`, nowIso);

    logDbSummaryWrite(sessionId, summaryType, summaryText.length, keywords);
  }

  persistLargeToolOutput(sessionId: string, toolCallId: string, toolName: string, output: string): string | null {
    if (output.length <= LARGE_OUTPUT_THRESHOLD) return null;

    const sanitizedToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const sanitizedCallId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `${sessionId}-${sanitizedToolName}-${sanitizedCallId}.txt`;
    const filePath = resolve(this.toolOutputDir, fileName);

    writeFileSync(filePath, output, "utf8");
    logDiskLargeOutput(toolName, output.length, filePath);
    return filePath;
  }

  appendToolContextEntry(toolName: string, entry: ToolContextEntry): void {
    const sanitized = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = resolve(this.toolContextDir, `${sanitized}.jsonl`);
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    logDiskToolContext(toolName, entry.status);
  }
}
