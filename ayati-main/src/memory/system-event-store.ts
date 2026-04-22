import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { AgentResponseKind } from "./types.js";
import type {
  SystemEventCreatedBy,
  SystemEventClass,
  SystemEventEffectLevel,
  SystemEventTrustTier,
} from "../core/contracts/plugin.js";
import { devWarn } from "../shared/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");

export interface SqliteSystemEventStoreOptions {
  dataDir?: string;
  dbPath?: string;
}

export interface SystemEventLedgerReceivedInput {
  clientId: string;
  sessionId: string;
  runId: string;
  eventId: string;
  source: string;
  eventName: string;
  eventClass: SystemEventClass;
  trustTier: SystemEventTrustTier;
  effectLevel: SystemEventEffectLevel;
  createdBy: SystemEventCreatedBy;
  requestedAction?: string;
  modeApplied: string;
  approvalState: string;
  summary: string;
  payload?: Record<string, unknown>;
  receivedAt: string;
}

export interface SystemEventLedgerOutcomeInput {
  runId: string;
  eventId: string;
  status: "completed" | "failed";
  processedAt: string;
  responseKind?: AgentResponseKind;
  approvalState?: string;
  note?: string;
}

export class SqliteSystemEventStore {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(options?: SqliteSystemEventStoreOptions) {
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

  recordReceived(input: SystemEventLedgerReceivedInput): void {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO system_events (
        event_id,
        client_id,
        session_id,
        run_id,
        source,
        event_name,
        event_class,
        trust_tier,
        effect_level,
        created_by,
        requested_action,
        mode_applied,
        status,
        summary,
        payload_json,
        received_at,
        processed_at,
        response_kind,
        approval_state,
        note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, NULL, NULL, ?, NULL)
      ON CONFLICT(event_id) DO UPDATE SET
        client_id = excluded.client_id,
        session_id = excluded.session_id,
        run_id = excluded.run_id,
        source = excluded.source,
        event_name = excluded.event_name,
        event_class = excluded.event_class,
        trust_tier = excluded.trust_tier,
        effect_level = excluded.effect_level,
        created_by = excluded.created_by,
        requested_action = excluded.requested_action,
        mode_applied = excluded.mode_applied,
        summary = excluded.summary,
        payload_json = excluded.payload_json,
        received_at = excluded.received_at,
        approval_state = excluded.approval_state
    `).run(
      input.eventId,
      input.clientId,
      input.sessionId,
      input.runId,
      input.source,
      input.eventName,
      input.eventClass,
      input.trustTier,
      input.effectLevel,
      input.createdBy,
      input.requestedAction ?? null,
      input.modeApplied,
      input.summary,
      serializePayload(input.payload),
      input.receivedAt,
      input.approvalState,
    );
  }

  recordOutcome(input: SystemEventLedgerOutcomeInput): void {
    const db = this.requireDb();
    db.prepare(`
      UPDATE system_events
      SET
        status = ?,
        processed_at = ?,
        response_kind = ?,
        approval_state = COALESCE(?, approval_state),
        note = ?
      WHERE run_id = ? OR event_id = ?
    `).run(
      input.status,
      input.processedAt,
      input.responseKind ?? null,
      input.approvalState ?? null,
      input.note ?? null,
      input.runId,
      input.eventId,
    );
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("SqliteSystemEventStore not started");
    }
    return this.db;
  }

  private createSchema(): void {
    const db = this.requireDb();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS system_events (
          event_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          source TEXT NOT NULL,
          event_name TEXT NOT NULL,
          event_class TEXT NOT NULL,
          trust_tier TEXT NOT NULL,
          effect_level TEXT NOT NULL,
          created_by TEXT NOT NULL,
          requested_action TEXT,
          mode_applied TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('received', 'completed', 'failed')),
          summary TEXT NOT NULL,
          payload_json TEXT,
          received_at TEXT NOT NULL,
          processed_at TEXT,
          response_kind TEXT,
          approval_state TEXT,
          note TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_system_events_session_recent
          ON system_events(session_id, received_at DESC);

        CREATE INDEX IF NOT EXISTS idx_system_events_client_recent
          ON system_events(client_id, received_at DESC);

        CREATE INDEX IF NOT EXISTS idx_system_events_source_recent
          ON system_events(source, received_at DESC);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_system_events_run_id
          ON system_events(run_id);
      `);
    } catch (err) {
      devWarn(
        "SQLite system_events schema initialization failed:",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }
}

function serializePayload(payload: Record<string, unknown> | undefined): string | null {
  if (!payload) {
    return null;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ error: "payload_serialization_failed" });
  }
}
