import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { CanonicalInboundEvent, ExternalSystemRequest } from "../contracts/system-ingress.js";
import { devWarn } from "../../shared/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");

export interface InboundQueueStoreOptions {
  dataDir?: string;
  dbPath?: string;
}

export interface QueueEnqueueInput {
  clientId: string;
  source: string;
  event: CanonicalInboundEvent;
  dedupeKey: string;
  rawRequest?: ExternalSystemRequest;
  createdAt?: string;
}

export interface QueueEnqueueResult {
  queued: boolean;
  queueId?: number;
}

export interface QueuedInboundEventRecord {
  id: number;
  clientId: string;
  source: string;
  eventId: string;
  dedupeKey: string;
  event: CanonicalInboundEvent;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  availableAt: string;
  rawRequest?: ExternalSystemRequest;
  lastError?: string;
}

export class InboundQueueStore {
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(options?: InboundQueueStoreOptions) {
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

  enqueue(input: QueueEnqueueInput): QueueEnqueueResult {
    const db = this.requireDb();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO inbound_event_queue (
        client_id,
        source,
        event_id,
        dedupe_key,
        status,
        canonical_event_json,
        raw_request_json,
        attempt_count,
        last_error,
        created_at,
        updated_at,
        available_at,
        processed_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, NULL, ?, ?, ?, NULL)
      ON CONFLICT(dedupe_key) DO NOTHING
    `).run(
      input.clientId,
      input.source,
      input.event.eventId,
      input.dedupeKey,
      JSON.stringify(input.event),
      serializeJson(input.rawRequest),
      createdAt,
      createdAt,
      createdAt,
    );

    const changes = Number(result.changes ?? 0);
    if (changes === 0) {
      return { queued: false };
    }

    return {
      queued: true,
      queueId: Number(result.lastInsertRowid),
    };
  }

  recoverInFlight(): number {
    const db = this.requireDb();
    const recoveredAt = new Date().toISOString();
    const result = db.prepare(`
      UPDATE inbound_event_queue
      SET
        status = 'queued',
        updated_at = ?,
        available_at = ?
      WHERE status = 'processing'
    `).run(recoveredAt, recoveredAt);
    return Number(result.changes ?? 0);
  }

  claimNext(availableBefore = new Date().toISOString()): QueuedInboundEventRecord | null {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE;");
    try {
      const row = db.prepare(`
        SELECT
          id,
          client_id,
          source,
          event_id,
          dedupe_key,
          canonical_event_json,
          raw_request_json,
          attempt_count,
          last_error,
          created_at,
          updated_at,
          available_at
        FROM inbound_event_queue
        WHERE status = 'queued'
          AND available_at <= ?
        ORDER BY id ASC
        LIMIT 1
      `).get(availableBefore) as Record<string, unknown> | undefined;

      if (!row) {
        db.exec("COMMIT;");
        return null;
      }

      const claimedAt = new Date().toISOString();
      db.prepare(`
        UPDATE inbound_event_queue
        SET
          status = 'processing',
          updated_at = ?
        WHERE id = ?
      `).run(claimedAt, Number(row["id"]));
      db.exec("COMMIT;");
      return deserializeRow(row);
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  markCompleted(id: number, processedAt = new Date().toISOString()): void {
    const db = this.requireDb();
    db.prepare(`
      UPDATE inbound_event_queue
      SET
        status = 'completed',
        processed_at = ?,
        updated_at = ?,
        last_error = NULL
      WHERE id = ?
    `).run(processedAt, processedAt, id);
  }

  reschedule(id: number, errorMessage: string, availableAt: string): void {
    const db = this.requireDb();
    const updatedAt = new Date().toISOString();
    db.prepare(`
      UPDATE inbound_event_queue
      SET
        status = 'queued',
        attempt_count = attempt_count + 1,
        last_error = ?,
        updated_at = ?,
        available_at = ?
      WHERE id = ?
    `).run(errorMessage, updatedAt, availableAt, id);
  }

  markFailed(id: number, errorMessage: string, processedAt = new Date().toISOString()): void {
    const db = this.requireDb();
    db.prepare(`
      UPDATE inbound_event_queue
      SET
        status = 'failed',
        attempt_count = attempt_count + 1,
        last_error = ?,
        processed_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(errorMessage, processedAt, processedAt, id);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("InboundQueueStore not started");
    }
    return this.db;
  }

  private createSchema(): void {
    const db = this.requireDb();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS inbound_event_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT NOT NULL,
          source TEXT NOT NULL,
          event_id TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
          canonical_event_json TEXT NOT NULL,
          raw_request_json TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          available_at TEXT NOT NULL,
          processed_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_event_queue_dedupe
          ON inbound_event_queue(dedupe_key);

        CREATE INDEX IF NOT EXISTS idx_inbound_event_queue_status_available
          ON inbound_event_queue(status, available_at, id);

        CREATE INDEX IF NOT EXISTS idx_inbound_event_queue_source_created
          ON inbound_event_queue(source, created_at DESC);
      `);
    } catch (err) {
      devWarn(
        "SQLite inbound_event_queue schema initialization failed:",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }
}

function deserializeRow(row: Record<string, unknown>): QueuedInboundEventRecord {
  return {
    id: Number(row["id"]),
    clientId: String(row["client_id"]),
    source: String(row["source"]),
    eventId: String(row["event_id"]),
    dedupeKey: String(row["dedupe_key"]),
    event: JSON.parse(String(row["canonical_event_json"])) as CanonicalInboundEvent,
    attemptCount: Number(row["attempt_count"] ?? 0),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    availableAt: String(row["available_at"]),
    ...(typeof row["last_error"] === "string" ? { lastError: row["last_error"] } : {}),
    ...(typeof row["raw_request_json"] === "string" && row["raw_request_json"].length > 0
      ? { rawRequest: JSON.parse(String(row["raw_request_json"])) as ExternalSystemRequest }
      : {}),
  };
}

function serializeJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "serialization_failed" });
  }
}
