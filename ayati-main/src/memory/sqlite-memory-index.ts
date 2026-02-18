import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { devWarn } from "../shared/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");

export type SessionMetaStatus = "active" | "closed" | "crashed";

export interface SessionMetaRecord {
  sessionId: string;
  clientId: string;
  status: SessionMetaStatus;
  sessionPath: string;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  parentSessionId: string | null;
  handoffSummary: string | null;
  lastEventAt: string;
  updatedAt: string;
}

export interface OpenSessionInput {
  sessionId: string;
  clientId: string;
  sessionPath: string;
  openedAt: string;
  parentSessionId?: string;
  handoffSummary?: string;
}

export interface SqliteMemoryIndexOptions {
  dataDir?: string;
  dbPath?: string;
}

function clampLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.floor(limit);
}

export class SqliteMemoryIndex {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(options?: SqliteMemoryIndexOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.dbPath = options?.dbPath ?? resolve(dataDir, "memory.sqlite");
  }

  start(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.createSchema();
  }

  stop(): void {
    this.db?.close();
    this.db = null;
  }

  openSession(input: OpenSessionInput): void {
    const db = this.requireDb();

    db.prepare(`
      UPDATE sessions_meta
      SET
        status = 'crashed',
        closed_at = COALESCE(closed_at, ?),
        close_reason = COALESCE(close_reason, 'superseded_by_new_session'),
        last_event_at = ?,
        updated_at = ?
      WHERE client_id = ?
        AND status = 'active'
        AND session_id <> ?
    `).run(
      input.openedAt,
      input.openedAt,
      input.openedAt,
      input.clientId,
      input.sessionId,
    );

    db.prepare(`
      INSERT INTO sessions_meta (
        session_id,
        client_id,
        status,
        session_path,
        opened_at,
        closed_at,
        close_reason,
        parent_session_id,
        handoff_summary,
        last_event_at,
        updated_at
      ) VALUES (?, ?, 'active', ?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        client_id = excluded.client_id,
        status = 'active',
        session_path = excluded.session_path,
        opened_at = excluded.opened_at,
        closed_at = NULL,
        close_reason = NULL,
        parent_session_id = excluded.parent_session_id,
        handoff_summary = excluded.handoff_summary,
        last_event_at = excluded.last_event_at,
        updated_at = excluded.updated_at
    `).run(
      input.sessionId,
      input.clientId,
      input.sessionPath,
      input.openedAt,
      input.parentSessionId ?? null,
      input.handoffSummary ?? null,
      input.openedAt,
      input.openedAt,
    );
  }

  resumeSession(
    sessionId: string,
    clientId: string,
    sessionPath: string,
    resumedAt: string,
    options?: { parentSessionId?: string; handoffSummary?: string },
  ): void {
    const db = this.requireDb();

    db.prepare(`
      UPDATE sessions_meta
      SET
        status = 'crashed',
        closed_at = COALESCE(closed_at, ?),
        close_reason = COALESCE(close_reason, 'superseded_by_restored_session'),
        last_event_at = ?,
        updated_at = ?
      WHERE client_id = ?
        AND status = 'active'
        AND session_id <> ?
    `).run(
      resumedAt,
      resumedAt,
      resumedAt,
      clientId,
      sessionId,
    );

    db.prepare(`
      INSERT INTO sessions_meta (
        session_id,
        client_id,
        status,
        session_path,
        opened_at,
        closed_at,
        close_reason,
        parent_session_id,
        handoff_summary,
        last_event_at,
        updated_at
      ) VALUES (?, ?, 'active', ?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        client_id = excluded.client_id,
        status = 'active',
        session_path = excluded.session_path,
        closed_at = NULL,
        close_reason = NULL,
        parent_session_id = COALESCE(excluded.parent_session_id, sessions_meta.parent_session_id),
        handoff_summary = COALESCE(excluded.handoff_summary, sessions_meta.handoff_summary),
        last_event_at = CASE
          WHEN sessions_meta.last_event_at > excluded.last_event_at THEN sessions_meta.last_event_at
          ELSE excluded.last_event_at
        END,
        updated_at = excluded.updated_at
    `).run(
      sessionId,
      clientId,
      sessionPath,
      resumedAt,
      options?.parentSessionId ?? null,
      options?.handoffSummary ?? null,
      resumedAt,
      resumedAt,
    );
  }

  recordEvent(sessionId: string, eventTs: string): void {
    const db = this.requireDb();
    db.prepare(`
      UPDATE sessions_meta
      SET
        last_event_at = ?,
        updated_at = ?
      WHERE session_id = ?
    `).run(
      eventTs,
      eventTs,
      sessionId,
    );
  }

  updateSessionPath(sessionId: string, sessionPath: string, updatedAt: string): void {
    const db = this.requireDb();
    db.prepare(`
      UPDATE sessions_meta
      SET
        session_path = ?,
        updated_at = ?
      WHERE session_id = ?
    `).run(
      sessionPath,
      updatedAt,
      sessionId,
    );
  }

  closeSession(
    sessionId: string,
    closedAt: string,
    reason: string,
    handoffSummary?: string,
  ): void {
    const db = this.requireDb();
    db.prepare(`
      UPDATE sessions_meta
      SET
        status = 'closed',
        closed_at = ?,
        close_reason = ?,
        handoff_summary = COALESCE(?, handoff_summary),
        last_event_at = ?,
        updated_at = ?
      WHERE session_id = ?
    `).run(
      closedAt,
      reason,
      handoffSummary ?? null,
      closedAt,
      closedAt,
      sessionId,
    );
  }

  markSessionCrashed(sessionId: string, crashedAt: string, reason: string): void {
    const db = this.requireDb();
    db.prepare(`
      UPDATE sessions_meta
      SET
        status = 'crashed',
        closed_at = COALESCE(closed_at, ?),
        close_reason = ?,
        last_event_at = ?,
        updated_at = ?
      WHERE session_id = ?
    `).run(
      crashedAt,
      reason,
      crashedAt,
      crashedAt,
      sessionId,
    );
  }

  getActiveSession(clientId: string): SessionMetaRecord | null {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT
        session_id,
        client_id,
        status,
        session_path,
        opened_at,
        closed_at,
        close_reason,
        parent_session_id,
        handoff_summary,
        last_event_at,
        updated_at
      FROM sessions_meta
      WHERE client_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(clientId) as SqliteSessionMetaRow | undefined;

    if (!row) return null;
    return this.mapRow(row);
  }

  listRecentSessions(clientId: string, limit = 32): SessionMetaRecord[] {
    const db = this.requireDb();
    const capped = Math.max(1, Math.min(500, clampLimit(limit, 32)));
    const rows = db.prepare(`
      SELECT
        session_id,
        client_id,
        status,
        session_path,
        opened_at,
        closed_at,
        close_reason,
        parent_session_id,
        handoff_summary,
        last_event_at,
        updated_at
      FROM sessions_meta
      WHERE client_id = ?
      ORDER BY
        CASE WHEN status = 'active' THEN 0 ELSE 1 END,
        updated_at DESC,
        rowid DESC
      LIMIT ?
    `).all(clientId, capped) as unknown as SqliteSessionMetaRow[];

    return rows.map((row) => this.mapRow(row));
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("SqliteMemoryIndex not started");
    }
    return this.db;
  }

  private mapRow(row: SqliteSessionMetaRow): SessionMetaRecord {
    return {
      sessionId: row.session_id,
      clientId: row.client_id,
      status: row.status,
      sessionPath: row.session_path,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      closeReason: row.close_reason,
      parentSessionId: row.parent_session_id,
      handoffSummary: row.handoff_summary,
      lastEventAt: row.last_event_at,
      updatedAt: row.updated_at,
    };
  }

  private createSchema(): void {
    const db = this.requireDb();
    try {
      db.exec(`
        DROP TABLE IF EXISTS session_metadata;
        DROP TABLE IF EXISTS session_summaries;
        DROP TABLE IF EXISTS summary_keywords;
        DROP TABLE IF EXISTS memory_mutations;
        DROP TABLE IF EXISTS icm_tasks;
        DROP TABLE IF EXISTS icm_links;
      `);

      if (!this.hasCompatibleSessionsMetaSchema(db)) {
        db.exec("DROP TABLE IF EXISTS sessions_meta;");
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions_meta (
          session_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'crashed')),
          session_path TEXT NOT NULL,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          close_reason TEXT,
          parent_session_id TEXT,
          handoff_summary TEXT,
          last_event_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_meta_one_active_per_client
          ON sessions_meta(client_id)
          WHERE status = 'active';

        CREATE INDEX IF NOT EXISTS idx_sessions_meta_client_recent
          ON sessions_meta(client_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_sessions_meta_status_recent
          ON sessions_meta(status, updated_at DESC);
      `);
    } catch (err) {
      devWarn(
        "SQLite sessions_meta schema initialization failed:",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  private hasCompatibleSessionsMetaSchema(db: DatabaseSync): boolean {
    const rows = db
      .prepare("PRAGMA table_info(sessions_meta)")
      .all() as Array<{ name: string }>;
    if (rows.length === 0) return false;

    const existing = new Set(rows.map((row) => row.name));
    if (existing.has("keywords_json")) return false;

    const required = [
      "session_id",
      "client_id",
      "status",
      "session_path",
      "opened_at",
      "closed_at",
      "close_reason",
      "parent_session_id",
      "handoff_summary",
      "last_event_at",
      "updated_at",
    ];

    return required.every((name) => existing.has(name));
  }
}

interface SqliteSessionMetaRow {
  session_id: string;
  client_id: string;
  status: SessionMetaStatus;
  session_path: string;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  parent_session_id: string | null;
  handoff_summary: string | null;
  last_event_at: string;
  updated_at: string;
}
