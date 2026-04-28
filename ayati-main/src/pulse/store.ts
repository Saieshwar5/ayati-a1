import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import {
  computeLatestDueAtOrBefore,
  computeNextOccurrenceAfter,
  computeNextTriggerForSchedule,
  previewPulseOccurrences,
  pulseDurationToMillis,
  pulseIntervalMsToValueUnit,
} from "./parser.js";
import { getClockHealth, getNowSnapshot, resolveTimeZone } from "./time.js";
import type {
  PulseClockHealth,
  PulseCreateItemInput,
  PulseCreateReminderInput,
  PulseDueOccurrenceLeaseOptions,
  PulseExecutionMode,
  PulseItem,
  PulseItemHistoryEntry,
  PulseItemKind,
  PulseItemPayload,
  PulseItemStatus,
  PulseLeasedOccurrence,
  PulseListItemsOptions,
  PulseListRemindersOptions,
  PulseMarkDeliveredInput,
  PulseOccurrence,
  PulseOccurrenceDispatchFailureInput,
  PulseOccurrenceDispatchSuccessInput,
  PulseOccurrenceDismissInput,
  PulseOccurrenceStatus,
  PulsePreviewOccurrence,
  PulsePreviewOptions,
  PulseReminder,
  PulseReminderSchedule,
  PulseScheduledItemIntentKind,
  PulseSchedule,
  PulseStoreDocument,
  PulseTaskSpec,
  PulseUpdateItemInput,
} from "./types.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");
const DEFAULT_DB_PATH = resolve(DEFAULT_DATA_DIR, "memory.sqlite");
const DEFAULT_LEGACY_STORE_FILE_PATH = resolve(projectRoot, "data", "pulse", "reminders.json");

const PULSE_STORE_PATH_ENV = "PULSE_STORE_FILE_PATH";
const PULSE_DB_PATH_ENV = "PULSE_DB_PATH";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const DEFAULT_PREVIEW_COUNT = 5;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_LEASE_LIMIT = 20;

interface LegacyPaths {
  dbPath: string;
  legacyFilePath: string;
}

interface RawItemRow {
  id: string;
  client_id: string;
  source: string;
  kind: string;
  status: string;
  execution_mode: string;
  title: string;
  instruction: string;
  timezone: string;
  schedule_json: string | null;
  payload_json: string | null;
  metadata_json: string | null;
  start_at_utc: string | null;
  end_at_utc: string | null;
  duration_ms: number | null;
  all_day: number;
  next_due_at: string | null;
  last_due_at: string | null;
  last_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawOccurrenceRow {
  id: string;
  item_id: string;
  scheduled_for: string;
  status: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_until: string | null;
  available_at: string;
  event_id: string | null;
  run_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PulseStoreOptions {
  dataDir?: string;
  dbPath?: string;
  legacyFilePath?: string;
  filePath?: string;
  now?: () => Date;
}

export class PulseStore {
  private readonly dbPath: string;
  private readonly legacyFilePath: string;
  private readonly nowProvider: () => Date;
  private db: DatabaseSync | null = null;
  private initialized = false;

  constructor(options?: PulseStoreOptions) {
    const resolved = resolvePulsePaths(options);
    this.dbPath = resolved.dbPath;
    this.legacyFilePath = resolved.legacyFilePath;
    this.nowProvider = options?.now ?? (() => new Date());
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.initialized = false;
  }

  async createItem(input: PulseCreateItemInput): Promise<PulseItem> {
    const now = this.nowProvider();
    const nowIso = now.toISOString();
    const item = this.transact((db) => {
      const normalized = normalizeCreateInput(input, now);
      const id = randomUUID();
      db.prepare(`
        INSERT INTO pulse_items (
          id,
          client_id,
          source,
          kind,
          status,
          execution_mode,
          title,
          instruction,
          timezone,
          schedule_json,
          payload_json,
          metadata_json,
          start_at_utc,
          end_at_utc,
          duration_ms,
          all_day,
          next_due_at,
          last_due_at,
          last_completed_at,
          created_at,
          updated_at
        ) VALUES (?, ?, 'pulse', ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(
        id,
        normalized.clientId,
        normalized.kind,
        normalized.executionMode,
        normalized.title,
        normalized.instruction,
        normalized.timezone,
        serializeJson(normalized.schedule),
        serializeJson(normalized.payload),
        serializeJson(normalized.metadata),
        normalized.startAtUtc,
        normalized.endAtUtc,
        normalized.durationMs,
        normalized.allDay ? 1 : 0,
        normalized.nextDueAt,
        nowIso,
        nowIso,
      );
      insertHistory(db, {
        itemId: id,
        clientId: normalized.clientId,
        action: "created",
        detail: {
          kind: normalized.kind,
          executionMode: normalized.executionMode,
          nextDueAt: normalized.nextDueAt,
        },
        createdAt: nowIso,
      });
      return getItemByIdTx(db, normalized.clientId, id);
    });

    if (!item) {
      throw new Error("Failed to create pulse item.");
    }
    return item;
  }

  async listItems(options: PulseListItemsOptions): Promise<PulseItem[]> {
    const status = options.status ?? "active";
    const kind = options.kind ?? "all";
    const limit = clampLimit(options.limit);
    const db = this.requireDb();
    const params: Array<string | number> = [options.clientId];
    const conditions = ["client_id = ?"];
    if (status !== "all") {
      conditions.push("status = ?");
      params.push(status);
    }
    if (kind !== "all") {
      conditions.push("kind = ?");
      params.push(kind);
    }
    params.push(limit);
    const rows = db.prepare(`
      SELECT *
      FROM pulse_items
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...params) as unknown as RawItemRow[];
    return rows.map((row) => hydrateItem(row));
  }

  async getItem(clientId: string, itemId: string): Promise<PulseItem | null> {
    const db = this.requireDb();
    return getItemByIdTx(db, clientId, itemId);
  }

  async getItemDetails(
    clientId: string,
    itemId: string,
    options?: { occurrenceLimit?: number; historyLimit?: number },
  ): Promise<{ item: PulseItem; occurrences: PulseOccurrence[]; history: PulseItemHistoryEntry[] } | null> {
    const db = this.requireDb();
    const item = getItemByIdTx(db, clientId, itemId);
    if (!item) {
      return null;
    }

    const occurrenceLimit = clampLimit(options?.occurrenceLimit ?? 10);
    const historyLimit = clampLimit(options?.historyLimit ?? 20);
    const occurrences = db.prepare(`
      SELECT *
      FROM pulse_occurrences
      WHERE item_id = ?
      ORDER BY scheduled_for DESC
      LIMIT ?
    `).all(itemId, occurrenceLimit) as unknown as RawOccurrenceRow[];
    const historyRows = db.prepare(`
      SELECT *
      FROM pulse_item_history
      WHERE item_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(itemId, historyLimit) as Array<{
      id: number;
      item_id: string;
      client_id: string;
      action: string;
      detail_json: string | null;
      created_at: string;
    }>;

    return {
      item,
      occurrences: occurrences.map((row) => hydrateOccurrence(row)),
      history: historyRows.map((row) => ({
        id: Number(row.id),
        itemId: row.item_id,
        clientId: row.client_id,
        action: row.action,
        detail: parseObjectJson(row.detail_json),
        createdAt: row.created_at,
      })),
    };
  }

  async updateItem(clientId: string, itemId: string, input: PulseUpdateItemInput): Promise<PulseItem | null> {
    const now = this.nowProvider();
    const nowIso = now.toISOString();
    return this.transact((db) => {
      const existing = getItemByIdTx(db, clientId, itemId);
      if (!existing) {
        return null;
      }

      const merged = normalizeUpdatedItem(existing, input, now);
      markOpenOccurrencesSkippedTx(db, itemId, nowIso, "item_updated");
      db.prepare(`
        UPDATE pulse_items
        SET
          title = ?,
          instruction = ?,
          timezone = ?,
          schedule_json = ?,
          payload_json = ?,
          metadata_json = ?,
          start_at_utc = ?,
          end_at_utc = ?,
          duration_ms = ?,
          all_day = ?,
          next_due_at = ?,
          updated_at = ?
        WHERE id = ? AND client_id = ?
      `).run(
        merged.title,
        merged.instruction,
        merged.timezone,
        serializeJson(merged.schedule),
        serializeJson(merged.payload),
        serializeJson(merged.metadata),
        merged.startAtUtc,
        merged.endAtUtc,
        merged.durationMs,
        merged.allDay ? 1 : 0,
        merged.nextDueAt,
        nowIso,
        itemId,
        clientId,
      );
      insertHistory(db, {
        itemId,
        clientId,
        action: "updated",
        detail: {
          nextDueAt: merged.nextDueAt,
        },
        createdAt: nowIso,
      });
      return getItemByIdTx(db, clientId, itemId);
    });
  }

  async pauseItem(clientId: string, itemId: string): Promise<PulseItem | null> {
    const nowIso = this.nowProvider().toISOString();
    return this.transact((db) => {
      const item = getItemByIdTx(db, clientId, itemId);
      if (!item) return null;
      markQueuedAndFailedOccurrencesSkippedTx(db, itemId, nowIso, "paused");
      db.prepare(`
        UPDATE pulse_items
        SET status = 'paused', updated_at = ?
        WHERE id = ? AND client_id = ?
      `).run(nowIso, itemId, clientId);
      insertHistory(db, {
        itemId,
        clientId,
        action: "paused",
        detail: {},
        createdAt: nowIso,
      });
      return getItemByIdTx(db, clientId, itemId);
    });
  }

  async resumeItem(clientId: string, itemId: string): Promise<PulseItem | null> {
    const now = this.nowProvider();
    const nowIso = now.toISOString();
    return this.transact((db) => {
      const item = getItemByIdTx(db, clientId, itemId);
      if (!item) return null;
      const nextDueAt = item.executionMode === "none"
        ? item.nextDueAt
        : item.nextDueAt ?? computeInitialNextDue(item.schedule, item.timezone, now, item.startAtUtc);
      db.prepare(`
        UPDATE pulse_items
        SET status = 'active', next_due_at = ?, updated_at = ?
        WHERE id = ? AND client_id = ?
      `).run(nextDueAt, nowIso, itemId, clientId);
      insertHistory(db, {
        itemId,
        clientId,
        action: "resumed",
        detail: { nextDueAt },
        createdAt: nowIso,
      });
      return getItemByIdTx(db, clientId, itemId);
    });
  }

  async cancelItem(clientId: string, itemId: string): Promise<PulseItem | null> {
    const nowIso = this.nowProvider().toISOString();
    return this.transact((db) => {
      const item = getItemByIdTx(db, clientId, itemId);
      if (!item) return null;
      markOpenOccurrencesSkippedTx(db, itemId, nowIso, "cancelled");
      db.prepare(`
        UPDATE pulse_items
        SET status = 'cancelled', next_due_at = NULL, updated_at = ?
        WHERE id = ? AND client_id = ?
      `).run(nowIso, itemId, clientId);
      insertHistory(db, {
        itemId,
        clientId,
        action: "cancelled",
        detail: {},
        createdAt: nowIso,
      });
      return getItemByIdTx(db, clientId, itemId);
    });
  }

  async deleteItem(clientId: string, itemId: string): Promise<boolean> {
    return this.transact((db) => {
      const item = getItemByIdTx(db, clientId, itemId);
      if (!item) return false;
      db.prepare("DELETE FROM pulse_occurrences WHERE item_id = ?").run(itemId);
      db.prepare("DELETE FROM pulse_item_history WHERE item_id = ?").run(itemId);
      const result = db.prepare("DELETE FROM pulse_items WHERE id = ? AND client_id = ?").run(itemId, clientId);
      return Number(result.changes ?? 0) > 0;
    });
  }

  async snoozeItem(clientId: string, itemId: string, delayMs: number): Promise<PulseItem | null> {
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      throw new Error("Snooze delay must be a positive duration.");
    }
    const now = this.nowProvider();
    const nowIso = now.toISOString();
    const nextDueAt = new Date(now.getTime() + delayMs).toISOString();
    return this.transact((db) => {
      const item = getItemByIdTx(db, clientId, itemId);
      if (!item) return null;
      markOpenOccurrencesSkippedTx(db, itemId, nowIso, "snoozed");
      db.prepare(`
        UPDATE pulse_items
        SET status = 'active', next_due_at = ?, updated_at = ?
        WHERE id = ? AND client_id = ?
      `).run(nextDueAt, nowIso, itemId, clientId);
      insertHistory(db, {
        itemId,
        clientId,
        action: "snoozed",
        detail: { delayMs, nextDueAt },
        createdAt: nowIso,
      });
      return getItemByIdTx(db, clientId, itemId);
    });
  }

  async dismissItem(input: PulseOccurrenceDismissInput): Promise<PulseItem | null> {
    const now = input.now ?? this.nowProvider();
    const nowIso = now.toISOString();
    return this.transact((db) => {
      const item = getItemByIdTx(db, input.clientId, input.itemId);
      if (!item) return null;

      const occurrence = input.occurrenceId
        ? getOccurrenceByIdTx(db, input.occurrenceId)
        : findDismissibleOccurrenceTx(db, item, now);
      if (!occurrence) {
        return null;
      }

      finalizeOccurrenceTx(db, item, occurrence, "skipped", nowIso, "dismissed", null);
      insertHistory(db, {
        itemId: item.id,
        clientId: input.clientId,
        action: "dismissed",
        detail: { occurrenceId: occurrence.id },
        createdAt: nowIso,
      });
      return getItemByIdTx(db, input.clientId, input.itemId);
    });
  }

  async preview(options: PulsePreviewOptions): Promise<PulsePreviewOccurrence[]> {
    const now = this.nowProvider();
    if (options.itemId) {
      const db = this.requireDb();
      const item = getItemByAnyIdTx(db, options.itemId);
      if (!item) return [];
      return previewPulseOccurrences(
        item.schedule,
        item.timezone,
        now,
        options.count ?? DEFAULT_PREVIEW_COUNT,
        item.startAtUtc,
      );
    }
    return previewPulseOccurrences(
      options.schedule ?? null,
      options.timezone,
      now,
      options.count ?? DEFAULT_PREVIEW_COUNT,
      options.startAtUtc,
    );
  }

  getNowSnapshot(timezoneInput?: string) {
    return getNowSnapshot(this.nowProvider(), timezoneInput);
  }

  getClockHealth(timezoneInput?: string): PulseClockHealth {
    return getClockHealth(this.nowProvider(), timezoneInput);
  }

  async leaseDueOccurrences(options: PulseDueOccurrenceLeaseOptions): Promise<PulseLeasedOccurrence[]> {
    const now = options.now ?? this.nowProvider();
    const nowIso = now.toISOString();
    const leaseMs = Math.max(1_000, Math.trunc(options.leaseMs));
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const limit = Math.max(1, Math.min(DEFAULT_LEASE_LIMIT, Math.trunc(options.limit ?? DEFAULT_LEASE_LIMIT)));

    return this.transact((db) => {
      reconcileOccurrencesTx(db, options.clientId, now);
      materializeDueOccurrencesTx(db, options.clientId, now);
      const rows = db.prepare(`
        SELECT o.*
        FROM pulse_occurrences o
        JOIN pulse_items i ON i.id = o.item_id
        WHERE i.client_id = ?
          AND i.status = 'active'
          AND o.status IN ('queued', 'failed')
          AND o.available_at <= ?
        ORDER BY o.scheduled_for ASC
        LIMIT ?
      `).all(options.clientId, nowIso, limit) as unknown as RawOccurrenceRow[];

      const leased: PulseLeasedOccurrence[] = [];
      for (const row of rows) {
        db.prepare(`
          UPDATE pulse_occurrences
          SET
            status = 'leased',
            lease_owner = ?,
            lease_until = ?,
            attempt_count = attempt_count + 1,
            updated_at = ?
          WHERE id = ?
        `).run(options.leaseOwner, leaseUntil, nowIso, row.id);
        const occurrence = getOccurrenceByIdTx(db, row.id);
        const item = getItemByIdForOccurrenceTx(db, row.item_id);
        if (occurrence && item) {
          leased.push({ item, occurrence });
        }
      }
      return leased;
    });
  }

  async recordOccurrenceDispatched(input: PulseOccurrenceDispatchSuccessInput): Promise<PulseOccurrence | null> {
    const nowIso = (input.now ?? this.nowProvider()).toISOString();
    return this.transact((db) => {
      const occurrence = getOccurrenceByIdTx(db, input.occurrenceId);
      if (!occurrence) return null;
      db.prepare(`
        UPDATE pulse_occurrences
        SET event_id = ?, updated_at = ?
        WHERE id = ?
      `).run(input.eventId, nowIso, input.occurrenceId);
      return getOccurrenceByIdTx(db, input.occurrenceId);
    });
  }

  async markOccurrenceDispatchFailure(input: PulseOccurrenceDispatchFailureInput): Promise<PulseOccurrence | null> {
    const now = input.now ?? this.nowProvider();
    const nowIso = now.toISOString();
    return this.transact((db) => {
      const occurrence = getOccurrenceByIdTx(db, input.occurrenceId);
      if (!occurrence) return null;
      const item = getItemByIdForOccurrenceTx(db, occurrence.itemId);
      if (!item) return occurrence;

      const retryPolicy = getRetryPolicy(item.payload);
      if (occurrence.attemptCount >= retryPolicy.maxAttempts) {
        finalizeOccurrenceTx(db, item, occurrence, "dead_lettered", nowIso, input.errorMessage, null);
        return getOccurrenceByIdTx(db, input.occurrenceId);
      }

      const availableAt = new Date(now.getTime() + computeBackoffMs(retryPolicy.baseDelayMs, occurrence.attemptCount)).toISOString();
      db.prepare(`
        UPDATE pulse_occurrences
        SET
          status = 'failed',
          lease_owner = NULL,
          lease_until = NULL,
          available_at = ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
      `).run(availableAt, input.errorMessage, nowIso, input.occurrenceId);
      return getOccurrenceByIdTx(db, input.occurrenceId);
    });
  }

  async reconcileOccurrences(clientId: string, nowInput?: Date): Promise<void> {
    this.transact((db) => {
      reconcileOccurrencesTx(db, clientId, nowInput ?? this.nowProvider());
    });
  }

  async createReminder(input: PulseCreateReminderInput): Promise<PulseReminder> {
    const item = await this.createItem({
      clientId: input.clientId,
      kind: input.intentKind === "task" ? "task" : "reminder",
      title: input.title,
      instruction: input.instruction,
      timezone: input.timezone,
      schedule: input.schedule,
      nextDueAt: input.nextTriggerAt,
      payload: {
        ...(input.requestedAction ? { requestedAction: input.requestedAction } : {}),
        ...(input.task ? { task: input.task } : {}),
        ...(input.originRunId ? { originRunId: input.originRunId } : {}),
        ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}),
      },
      metadata: input.metadata,
    });
    return this.toReminder(item);
  }

  async listReminders(options: PulseListRemindersOptions): Promise<PulseReminder[]> {
    const items = await this.listItems({
      clientId: options.clientId,
      status: options.status,
      limit: options.limit,
    });
    return items
      .filter((item) => item.kind === "reminder" || item.kind === "task")
      .map((item) => this.toReminder(item));
  }

  async cancelReminder(clientId: string, reminderId: string): Promise<PulseReminder | null> {
    const item = await this.cancelItem(clientId, reminderId);
    return item ? this.toReminder(item) : null;
  }

  async snoozeReminder(clientId: string, reminderId: string, delayMs: number): Promise<PulseReminder | null> {
    const item = await this.snoozeItem(clientId, reminderId, delayMs);
    return item ? this.toReminder(item) : null;
  }

  async getDueReminders(clientId: string, nowInput?: Date): Promise<PulseReminder[]> {
    const now = nowInput ?? this.nowProvider();
    const items = await this.listItems({
      clientId,
      status: "active",
      limit: MAX_LIST_LIMIT,
    });
    return items
      .filter((item) => (item.kind === "reminder" || item.kind === "task") && item.nextDueAt !== null)
      .filter((item) => Date.parse(item.nextDueAt ?? "") <= now.getTime())
      .map((item) => this.toReminder(item));
  }

  async markDelivered(input: PulseMarkDeliveredInput): Promise<PulseReminder | null> {
    const nowIso = this.nowProvider().toISOString();
    return this.transact((db) => {
      const item = getItemByIdTx(db, input.clientId, input.reminderId);
      if (!item) return null;
      const occurrence = getOccurrenceByIdTx(db, input.occurrenceId) ?? createOccurrenceShell(db, item, input.occurrenceId, input.scheduledFor, nowIso);
      finalizeOccurrenceTx(db, item, occurrence, "completed", nowIso, null, null);
      const updated = getItemByIdTx(db, input.clientId, input.reminderId);
      return updated ? this.toReminder(updated) : null;
    });
  }

  private toReminder(item: PulseItem): PulseReminder {
    if (item.kind !== "reminder" && item.kind !== "task") {
      throw new Error(`Pulse item ${item.id} is not a reminder/task.`);
    }

    const requestedAction = typeof item.payload.requestedAction === "string"
      ? item.payload.requestedAction
      : item.payload.task?.requestedAction;
    return {
      id: item.id,
      clientId: item.clientId,
      intentKind: item.kind === "task" ? "task" : "reminder",
      title: item.title,
      instruction: item.instruction,
      timezone: item.timezone,
      status: item.status === "paused" ? "active" : item.status,
      schedule: item.schedule as PulseReminderSchedule,
      nextTriggerAt: item.nextDueAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(item.lastDueAt ? { lastTriggeredAt: item.lastDueAt } : {}),
      ...(item.lastDueAt ? { lastDeliveredOccurrenceId: `${item.id}:${item.lastDueAt}` } : {}),
      ...(typeof item.payload.originRunId === "string" ? { originRunId: item.payload.originRunId } : {}),
      ...(typeof item.payload.originSessionId === "string" ? { originSessionId: item.payload.originSessionId } : {}),
      ...(requestedAction ? { requestedAction } : {}),
      ...(item.payload.task ? { task: item.payload.task } : {}),
      metadata: item.metadata,
    };
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA synchronous=NORMAL;");
    }
    if (!this.initialized) {
      this.createSchema();
      this.migrateLegacyStoreIfNeeded();
      this.initialized = true;
    }
    return this.db;
  }

  private transact<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn(db);
      db.exec("COMMIT;");
      return result;
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  private createSchema(): void {
    if (!this.db) {
      throw new Error("PulseStore database is not open");
    }
    const db = this.db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS pulse_items (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'pulse',
        kind TEXT NOT NULL CHECK (kind IN ('event', 'reminder', 'notification', 'task')),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('none', 'notify', 'run_task')),
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        timezone TEXT NOT NULL,
        schedule_json TEXT,
        payload_json TEXT,
        metadata_json TEXT,
        start_at_utc TEXT,
        end_at_utc TEXT,
        duration_ms INTEGER,
        all_day INTEGER NOT NULL DEFAULT 0,
        next_due_at TEXT,
        last_due_at TEXT,
        last_completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pulse_items_client_status_due
        ON pulse_items(client_id, status, next_due_at);

      CREATE INDEX IF NOT EXISTS idx_pulse_items_kind_updated
        ON pulse_items(kind, updated_at DESC);

      CREATE TABLE IF NOT EXISTS pulse_occurrences (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'skipped', 'dead_lettered')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until TEXT,
        available_at TEXT NOT NULL,
        event_id TEXT,
        run_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(item_id, scheduled_for)
      );

      CREATE INDEX IF NOT EXISTS idx_pulse_occurrences_due
        ON pulse_occurrences(status, available_at, scheduled_for);

      CREATE INDEX IF NOT EXISTS idx_pulse_occurrences_item_recent
        ON pulse_occurrences(item_id, scheduled_for DESC);

      CREATE INDEX IF NOT EXISTS idx_pulse_occurrences_event_id
        ON pulse_occurrences(event_id);

      CREATE TABLE IF NOT EXISTS pulse_item_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        action TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pulse_item_history_item_recent
        ON pulse_item_history(item_id, id DESC);
    `);
  }

  private migrateLegacyStoreIfNeeded(): void {
    if (!this.db) {
      throw new Error("PulseStore database is not open");
    }
    const db = this.db;
    const row = db.prepare("SELECT COUNT(*) AS count FROM pulse_items").get() as { count: number };
    if (Number(row.count ?? 0) > 0) {
      return;
    }

    if (!existsSync(this.legacyFilePath)) {
      return;
    }

    const document = parseLegacyDocument(this.legacyFilePath);
    if (!document || document.reminders.length === 0) {
      return;
    }

    for (const reminder of document.reminders) {
      const item = legacyReminderToItem(reminder);
      db.prepare(`
        INSERT OR IGNORE INTO pulse_items (
          id,
          client_id,
          source,
          kind,
          status,
          execution_mode,
          title,
          instruction,
          timezone,
          schedule_json,
          payload_json,
          metadata_json,
          start_at_utc,
          end_at_utc,
          duration_ms,
          all_day,
          next_due_at,
          last_due_at,
          last_completed_at,
          created_at,
          updated_at
        ) VALUES (?, ?, 'pulse', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?)
      `).run(
        item.id,
        item.clientId,
        item.kind,
        item.status,
        item.executionMode,
        item.title,
        item.instruction,
        item.timezone,
        serializeJson(item.schedule),
        serializeJson(item.payload),
        serializeJson(item.metadata),
        item.nextDueAt,
        item.lastDueAt,
        item.lastCompletedAt,
        item.createdAt,
        item.updatedAt,
      );
      insertHistory(db, {
        itemId: item.id,
        clientId: item.clientId,
        action: "migrated_legacy",
        detail: {
          nextDueAt: item.nextDueAt,
        },
        createdAt: item.createdAt,
      });
    }
  }
}

function resolvePulsePaths(options?: PulseStoreOptions): LegacyPaths {
  const compatibilityFilePath = options?.filePath?.trim();
  if (compatibilityFilePath) {
    const resolvedCompatibilityPath = resolve(compatibilityFilePath);
    if (resolvedCompatibilityPath.endsWith(".sqlite")) {
      return {
        dbPath: resolvedCompatibilityPath,
        legacyFilePath: options?.legacyFilePath?.trim()
          ? resolve(options.legacyFilePath)
          : DEFAULT_LEGACY_STORE_FILE_PATH,
      };
    }
    return {
      dbPath: resolve(dirname(resolvedCompatibilityPath), "memory.sqlite"),
      legacyFilePath: resolvedCompatibilityPath,
    };
  }

  const explicitDbPath = options?.dbPath?.trim();
  const explicitLegacyPath = options?.legacyFilePath?.trim();
  if (explicitDbPath) {
    return {
      dbPath: resolve(explicitDbPath),
      legacyFilePath: explicitLegacyPath ? resolve(explicitLegacyPath) : DEFAULT_LEGACY_STORE_FILE_PATH,
    };
  }

  const envDbPath = process.env[PULSE_DB_PATH_ENV]?.trim();
  if (envDbPath) {
    return {
      dbPath: resolve(envDbPath),
      legacyFilePath: explicitLegacyPath ? resolve(explicitLegacyPath) : DEFAULT_LEGACY_STORE_FILE_PATH,
    };
  }

  const legacyCompatPath = process.env[PULSE_STORE_PATH_ENV]?.trim();
  if (legacyCompatPath) {
    const resolvedCompatPath = resolve(legacyCompatPath);
    if (resolvedCompatPath.endsWith(".sqlite")) {
      return {
        dbPath: resolvedCompatPath,
        legacyFilePath: explicitLegacyPath ? resolve(explicitLegacyPath) : DEFAULT_LEGACY_STORE_FILE_PATH,
      };
    }
    return {
      dbPath: resolve(dirname(resolvedCompatPath), "memory.sqlite"),
      legacyFilePath: resolvedCompatPath,
    };
  }

  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
  return {
    dbPath: resolve(dataDir, "memory.sqlite"),
    legacyFilePath: explicitLegacyPath ? resolve(explicitLegacyPath) : DEFAULT_LEGACY_STORE_FILE_PATH,
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIST_LIMIT;
  const integer = Math.trunc(limit);
  return Math.max(1, Math.min(MAX_LIST_LIMIT, integer));
}

function defaultExecutionMode(kind: PulseItemKind): PulseExecutionMode {
  if (kind === "event") return "none";
  if (kind === "task") return "run_task";
  return "notify";
}

function normalizePayload(input: PulseItemPayload | undefined, kind: PulseItemKind): PulseItemPayload {
  const task = isObject(input?.task) ? normalizeTaskSpec(input?.task) : undefined;
  const requestedAction = typeof input?.requestedAction === "string" && input.requestedAction.trim().length > 0
    ? input.requestedAction.trim()
    : task?.requestedAction;
  const tags = Array.isArray(input?.tags)
    ? input.tags.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
    : undefined;

  return {
    ...cloneObject(input),
    catchUpMode: "latest_only",
    concurrencyMode: "single_flight",
    retry: {
      maxAttempts: DEFAULT_RETRY_ATTEMPTS,
      baseDelayMs: DEFAULT_RETRY_DELAY_MS,
      ...(isObject(input?.retry) ? input.retry : {}),
    },
    ...(requestedAction ? { requestedAction } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(task ? { task } : {}),
    ...(kind === "task" && !task ? { task: { objective: "" } } : {}),
  };
}

function normalizeTaskSpec(value: unknown): PulseTaskSpec | undefined {
  if (!isObject(value)) return undefined;
  const objective = typeof value["objective"] === "string" ? value["objective"].trim() : "";
  if (objective.length === 0) return undefined;
  const requestedAction = typeof value["requestedAction"] === "string" && value["requestedAction"].trim().length > 0
    ? value["requestedAction"].trim()
    : undefined;
  const constraints = sanitizeStringArray(value["constraints"]);
  const successCriteria = sanitizeStringArray(value["successCriteria"]);
  return {
    objective,
    ...(requestedAction ? { requestedAction } : {}),
    ...(isObject(value["inputs"]) ? { inputs: value["inputs"] } : {}),
    ...(isObject(value["context"]) ? { context: value["context"] } : {}),
    ...(constraints ? { constraints } : {}),
    ...(successCriteria ? { successCriteria } : {}),
  };
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizeSchedule(schedule: PulseSchedule | null | undefined): PulseSchedule | null {
  if (!schedule) return null;
  if (schedule.kind === "interval") {
    const existingEveryMs = Number.isFinite(schedule.everyMs) && schedule.everyMs > 0 ? Math.trunc(schedule.everyMs) : undefined;
    const existingValue = typeof schedule.value === "number" && Number.isFinite(schedule.value) && schedule.value > 0
      ? Math.trunc(schedule.value)
      : undefined;
    const existingUnit = typeof schedule.unit === "string" ? schedule.unit : undefined;
    const everyMs = existingEveryMs ?? (existingValue && existingUnit ? pulseDurationToMillis(existingValue, existingUnit) ?? undefined : undefined);
    const derived = everyMs ? pulseIntervalMsToValueUnit(everyMs) : null;
    return {
      ...schedule,
      everyMs: everyMs ?? schedule.everyMs,
      ...(existingValue !== undefined ? { value: existingValue } : derived ? { value: derived.value } : {}),
      ...(existingUnit ? { unit: existingUnit } : derived ? { unit: derived.unit } : {}),
    };
  }
  if (schedule.kind === "weekly") {
    const weekdays = schedule.weekdays?.length
      ? schedule.weekdays
      : schedule.weekday !== undefined
        ? [schedule.weekday]
        : [];
    const deduped = Array.from(new Set(weekdays.filter((entry) => entry >= 1 && entry <= 7))).sort((a, b) => a - b);
    return {
      ...schedule,
      weekday: deduped[0] ?? 1,
      weekdays: deduped.length > 0 ? deduped : [1],
    };
  }
  return schedule;
}

function normalizeCreateInput(input: PulseCreateItemInput, now: Date): PulseItem {
  const timezone = resolveTimeZone(input.timezone);
  const schedule = normalizeSchedule(input.schedule ?? null);
  const payload = normalizePayload(input.payload, input.kind);
  const nextDueAt = input.nextDueAt ?? computeInitialNextDue(schedule, timezone, now, input.startAtUtc ?? null, input.executionMode ?? defaultExecutionMode(input.kind));
  return {
    id: "",
    clientId: input.clientId,
    source: "pulse",
    kind: input.kind,
    status: "active",
    executionMode: input.executionMode ?? defaultExecutionMode(input.kind),
    title: input.title.trim(),
    instruction: input.instruction.trim(),
    timezone,
    schedule,
    payload,
    metadata: cloneObject(input.metadata),
    startAtUtc: input.startAtUtc ?? null,
    endAtUtc: resolveEndAt(input.startAtUtc ?? null, input.endAtUtc ?? null, input.durationMs ?? null),
    durationMs: input.durationMs ?? null,
    allDay: Boolean(input.allDay),
    nextDueAt,
    lastDueAt: null,
    lastCompletedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function normalizeUpdatedItem(existing: PulseItem, input: PulseUpdateItemInput, now: Date): PulseItem {
  const kind = existing.kind;
  const timezone = resolveTimeZone(input.timezone ?? existing.timezone);
  const schedule = input.schedule !== undefined ? normalizeSchedule(input.schedule) : existing.schedule;
  const mergedPayload = input.payload !== undefined
    ? normalizePayload({ ...existing.payload, ...cloneObject(input.payload) }, kind)
    : existing.payload;
  const metadata = input.metadata !== undefined ? cloneObject(input.metadata) : existing.metadata;
  const startAtUtc = input.startAtUtc !== undefined ? input.startAtUtc : existing.startAtUtc;
  const durationMs = input.durationMs !== undefined ? input.durationMs : existing.durationMs;
  const endAtUtc = input.endAtUtc !== undefined
    ? input.endAtUtc
    : resolveEndAt(startAtUtc, existing.endAtUtc, durationMs);
  const executionMode = existing.executionMode;
  const nextDueAt = input.nextDueAt !== undefined
    ? input.nextDueAt
    : computeInitialNextDue(schedule, timezone, now, startAtUtc, executionMode);

  return {
    ...existing,
    title: input.title?.trim() ?? existing.title,
    instruction: input.instruction?.trim() ?? existing.instruction,
    timezone,
    schedule,
    payload: mergedPayload,
    metadata,
    startAtUtc,
    endAtUtc,
    durationMs,
    allDay: input.allDay !== undefined ? Boolean(input.allDay) : existing.allDay,
    nextDueAt,
    updatedAt: now.toISOString(),
  };
}

function computeInitialNextDue(
  schedule: PulseSchedule | null,
  timezone: string,
  now: Date,
  startAtUtc: string | null,
  executionMode: PulseExecutionMode = "notify",
): string | null {
  if (executionMode === "none") {
    return null;
  }
  if (schedule) {
    if (schedule.kind === "once") {
      return schedule.at;
    }
    return computeNextOccurrenceAfter(schedule, timezone, now);
  }
  return startAtUtc;
}

function resolveEndAt(startAtUtc: string | null, endAtUtc: string | null, durationMs: number | null): string | null {
  if (endAtUtc) return endAtUtc;
  if (!startAtUtc || !durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  const startMillis = Date.parse(startAtUtc);
  if (!Number.isFinite(startMillis)) return null;
  return new Date(startMillis + durationMs).toISOString();
}

function getRetryPolicy(payload: PulseItemPayload): { maxAttempts: number; baseDelayMs: number } {
  const retry = isObject(payload.retry) ? payload.retry : {};
  const maxAttempts = typeof retry.maxAttempts === "number" && Number.isFinite(retry.maxAttempts) && retry.maxAttempts > 0
    ? Math.trunc(retry.maxAttempts)
    : DEFAULT_RETRY_ATTEMPTS;
  const baseDelayMs = typeof retry.baseDelayMs === "number" && Number.isFinite(retry.baseDelayMs) && retry.baseDelayMs > 0
    ? Math.trunc(retry.baseDelayMs)
    : DEFAULT_RETRY_DELAY_MS;
  return { maxAttempts, baseDelayMs };
}

function computeBackoffMs(baseDelayMs: number, attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return baseDelayMs * Math.pow(2, exponent);
}

function reconcileOccurrencesTx(db: DatabaseSync, clientId: string, now: Date): void {
  const nowIso = now.toISOString();
  const itemsById = new Map<string, PulseItem>();
  const occurrenceRows = db.prepare(`
    SELECT o.*
    FROM pulse_occurrences o
    JOIN pulse_items i ON i.id = o.item_id
    WHERE i.client_id = ?
      AND o.status = 'leased'
  `).all(clientId) as unknown as RawOccurrenceRow[];

  const systemEventsTableExists = tableExists(db, "system_events");
  const statusLookup = systemEventsTableExists
    ? buildEventStatusLookup(db, occurrenceRows.map((row) => row.event_id).filter((value): value is string => typeof value === "string" && value.length > 0))
    : new Map<string, { status: "completed" | "failed"; processedAt: string | null; runId: string | null; note: string | null }>();

  for (const row of occurrenceRows) {
    const item = itemsById.get(row.item_id) ?? getItemByIdForOccurrenceTx(db, row.item_id);
    if (!item) {
      continue;
    }
    itemsById.set(row.item_id, item);
    const occurrence = hydrateOccurrence(row);
    const eventStatus = occurrence.eventId ? statusLookup.get(occurrence.eventId) : undefined;

    if (eventStatus?.status === "completed") {
      finalizeOccurrenceTx(db, item, occurrence, "completed", eventStatus.processedAt ?? nowIso, null, eventStatus.runId);
      continue;
    }

    if (eventStatus?.status === "failed") {
      const retryPolicy = getRetryPolicy(item.payload);
      if (occurrence.attemptCount >= retryPolicy.maxAttempts) {
        finalizeOccurrenceTx(db, item, occurrence, "dead_lettered", eventStatus.processedAt ?? nowIso, eventStatus.note, eventStatus.runId);
      } else {
        db.prepare(`
          UPDATE pulse_occurrences
          SET
            status = 'failed',
            lease_owner = NULL,
            lease_until = NULL,
            available_at = ?,
            run_id = ?,
            last_error = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          new Date(now.getTime() + computeBackoffMs(retryPolicy.baseDelayMs, occurrence.attemptCount)).toISOString(),
          eventStatus.runId,
          eventStatus.note,
          nowIso,
          occurrence.id,
        );
      }
      continue;
    }

    if (occurrence.leaseUntil && occurrence.leaseUntil <= nowIso) {
      const retryPolicy = getRetryPolicy(item.payload);
      if (occurrence.attemptCount >= retryPolicy.maxAttempts) {
        finalizeOccurrenceTx(db, item, occurrence, "dead_lettered", nowIso, "lease expired before outcome was recorded", occurrence.runId);
      } else {
        db.prepare(`
          UPDATE pulse_occurrences
          SET
            status = 'failed',
            lease_owner = NULL,
            lease_until = NULL,
            available_at = ?,
            last_error = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          new Date(now.getTime() + computeBackoffMs(retryPolicy.baseDelayMs, occurrence.attemptCount)).toISOString(),
          "lease expired before outcome was recorded",
          nowIso,
          occurrence.id,
        );
      }
    }
  }
}

function materializeDueOccurrencesTx(db: DatabaseSync, clientId: string, now: Date): void {
  const nowIso = now.toISOString();
  const rows = db.prepare(`
    SELECT *
    FROM pulse_items
    WHERE client_id = ?
      AND status = 'active'
      AND execution_mode != 'none'
      AND next_due_at IS NOT NULL
      AND next_due_at <= ?
    ORDER BY next_due_at ASC
  `).all(clientId, nowIso) as unknown as RawItemRow[];

  for (const row of rows) {
    const item = hydrateItem(row);
    const openCountRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM pulse_occurrences
      WHERE item_id = ?
        AND status IN ('queued', 'leased', 'failed')
    `).get(item.id) as { count: number };
    if (Number(openCountRow.count ?? 0) > 0) {
      continue;
    }

    const scheduledFor = resolveCatchUpDueAt(item, now);
    if (!scheduledFor) {
      continue;
    }

    const occurrenceId = `${item.id}:${scheduledFor}`;
    db.prepare(`
      INSERT OR IGNORE INTO pulse_occurrences (
        id,
        item_id,
        scheduled_for,
        status,
        attempt_count,
        lease_owner,
        lease_until,
        available_at,
        event_id,
        run_id,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'queued', 0, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)
    `).run(occurrenceId, item.id, scheduledFor, nowIso, nowIso, nowIso);
    if (item.nextDueAt !== scheduledFor) {
      db.prepare(`
        UPDATE pulse_items
        SET next_due_at = ?, updated_at = ?
        WHERE id = ?
      `).run(scheduledFor, nowIso, item.id);
      insertHistory(db, {
        itemId: item.id,
        clientId: item.clientId,
        action: "catch_up_materialized",
        detail: {
          scheduledFor,
        },
        createdAt: nowIso,
      });
    }
  }
}

function resolveCatchUpDueAt(item: PulseItem, now: Date): string | null {
  if (!item.schedule) {
    return item.nextDueAt;
  }
  if (!item.nextDueAt) {
    return computeLatestDueAtOrBefore(item.schedule, item.timezone, now);
  }

  const latest = computeLatestDueAtOrBefore(item.schedule, item.timezone, now);
  if (!latest) {
    return item.nextDueAt;
  }
  if (latest > item.nextDueAt) {
    return latest;
  }
  return item.nextDueAt;
}

function finalizeOccurrenceTx(
  db: DatabaseSync,
  item: PulseItem,
  occurrence: PulseOccurrence,
  terminalStatus: Extract<PulseOccurrenceStatus, "completed" | "skipped" | "dead_lettered">,
  processedAt: string,
  errorMessage: string | null,
  runId: string | null,
): void {
  db.prepare(`
    UPDATE pulse_occurrences
    SET
      status = ?,
      lease_owner = NULL,
      lease_until = NULL,
      run_id = COALESCE(?, run_id),
      last_error = ?,
      updated_at = ?
    WHERE id = ?
  `).run(terminalStatus, runId, errorMessage, processedAt, occurrence.id);

  const nextDueAt = item.schedule
    ? computeNextOccurrenceAfter(item.schedule, item.timezone, occurrence.scheduledFor)
    : null;
  const nextStatus: PulseItemStatus = nextDueAt ? "active" : "completed";

  db.prepare(`
    UPDATE pulse_items
    SET
      status = ?,
      next_due_at = ?,
      last_due_at = ?,
      last_completed_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    nextStatus,
    nextDueAt,
    occurrence.scheduledFor,
    terminalStatus === "completed" ? processedAt : item.lastCompletedAt,
    processedAt,
    item.id,
  );

  insertHistory(db, {
    itemId: item.id,
    clientId: item.clientId,
    action: `occurrence_${terminalStatus}`,
    detail: {
      occurrenceId: occurrence.id,
      scheduledFor: occurrence.scheduledFor,
      nextDueAt,
      ...(errorMessage ? { errorMessage } : {}),
      ...(runId ? { runId } : {}),
    },
    createdAt: processedAt,
  });
}

function createOccurrenceShell(
  db: DatabaseSync,
  item: PulseItem,
  occurrenceId: string,
  scheduledFor: string,
  nowIso: string,
): PulseOccurrence {
  db.prepare(`
    INSERT OR IGNORE INTO pulse_occurrences (
      id,
      item_id,
      scheduled_for,
      status,
      attempt_count,
      lease_owner,
      lease_until,
      available_at,
      event_id,
      run_id,
      last_error,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'completed', 1, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)
  `).run(occurrenceId, item.id, scheduledFor, nowIso, nowIso, nowIso);
  const occurrence = getOccurrenceByIdTx(db, occurrenceId);
  if (!occurrence) {
    throw new Error(`Pulse occurrence ${occurrenceId} was not created.`);
  }
  return occurrence;
}

function findDismissibleOccurrenceTx(db: DatabaseSync, item: PulseItem, now: Date): PulseOccurrence | null {
  const open = db.prepare(`
    SELECT *
    FROM pulse_occurrences
    WHERE item_id = ?
      AND status IN ('queued', 'leased', 'failed')
    ORDER BY scheduled_for DESC
    LIMIT 1
  `).get(item.id) as RawOccurrenceRow | undefined;
  if (open) {
    return hydrateOccurrence(open);
  }

  if (!item.nextDueAt || Date.parse(item.nextDueAt) > now.getTime()) {
    return null;
  }

  return {
    id: `${item.id}:${item.nextDueAt}`,
    itemId: item.id,
    scheduledFor: item.nextDueAt,
    status: "queued",
    attemptCount: 0,
    leaseOwner: null,
    leaseUntil: null,
    availableAt: now.toISOString(),
    eventId: null,
    runId: null,
    lastError: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function buildEventStatusLookup(
  db: DatabaseSync,
  eventIds: string[],
): Map<string, { status: "completed" | "failed"; processedAt: string | null; runId: string | null; note: string | null }> {
  if (eventIds.length === 0) {
    return new Map();
  }
  const placeholders = eventIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT event_id, status, processed_at, run_id, note
    FROM system_events
    WHERE event_id IN (${placeholders})
      AND status IN ('completed', 'failed')
  `).all(...eventIds) as Array<{
    event_id: string;
    status: "completed" | "failed";
    processed_at: string | null;
    run_id: string | null;
    note: string | null;
  }>;
  const map = new Map<string, { status: "completed" | "failed"; processedAt: string | null; runId: string | null; note: string | null }>();
  for (const row of rows) {
    map.set(row.event_id, {
      status: row.status,
      processedAt: row.processed_at,
      runId: row.run_id,
      note: row.note,
    });
  }
  return map;
}

function markOpenOccurrencesSkippedTx(db: DatabaseSync, itemId: string, nowIso: string, reason: string): void {
  db.prepare(`
    UPDATE pulse_occurrences
    SET
      status = 'skipped',
      last_error = ?,
      lease_owner = NULL,
      lease_until = NULL,
      updated_at = ?
    WHERE item_id = ?
      AND status IN ('queued', 'leased', 'failed')
  `).run(reason, nowIso, itemId);
}

function markQueuedAndFailedOccurrencesSkippedTx(db: DatabaseSync, itemId: string, nowIso: string, reason: string): void {
  db.prepare(`
    UPDATE pulse_occurrences
    SET
      status = 'skipped',
      last_error = ?,
      updated_at = ?
    WHERE item_id = ?
      AND status IN ('queued', 'failed')
  `).run(reason, nowIso, itemId);
}

function getItemByIdTx(db: DatabaseSync, clientId: string, itemId: string): PulseItem | null {
  const row = db.prepare(`
    SELECT *
    FROM pulse_items
    WHERE id = ? AND client_id = ?
  `).get(itemId, clientId) as RawItemRow | undefined;
  return row ? hydrateItem(row) : null;
}

function getItemByAnyIdTx(db: DatabaseSync, itemId: string): PulseItem | null {
  const row = db.prepare(`
    SELECT *
    FROM pulse_items
    WHERE id = ?
  `).get(itemId) as RawItemRow | undefined;
  return row ? hydrateItem(row) : null;
}

function getItemByIdForOccurrenceTx(db: DatabaseSync, itemId: string): PulseItem | null {
  const row = db.prepare(`
    SELECT *
    FROM pulse_items
    WHERE id = ?
  `).get(itemId) as RawItemRow | undefined;
  return row ? hydrateItem(row) : null;
}

function getOccurrenceByIdTx(db: DatabaseSync, occurrenceId: string): PulseOccurrence | null {
  const row = db.prepare(`
    SELECT *
    FROM pulse_occurrences
    WHERE id = ?
  `).get(occurrenceId) as RawOccurrenceRow | undefined;
  return row ? hydrateOccurrence(row) : null;
}

function hydrateItem(row: RawItemRow): PulseItem {
  const kind = isPulseKind(row.kind) ? row.kind : "reminder";
  const payload = normalizePayload(parseObjectJson(row.payload_json), kind);
  const schedule = normalizeSchedule(parseScheduleJson(row.schedule_json));
  return {
    id: row.id,
    clientId: row.client_id,
    source: row.source === "pulse" ? "pulse" : "pulse",
    kind,
    status: isPulseStatus(row.status) ? row.status : "active",
    executionMode: isPulseExecutionMode(row.execution_mode) ? row.execution_mode : defaultExecutionMode(kind),
    title: row.title,
    instruction: row.instruction,
    timezone: resolveTimeZone(row.timezone),
    schedule,
    payload,
    metadata: parseObjectJson(row.metadata_json),
    startAtUtc: row.start_at_utc,
    endAtUtc: row.end_at_utc,
    durationMs: typeof row.duration_ms === "number" ? Number(row.duration_ms) : null,
    allDay: Number(row.all_day) === 1,
    nextDueAt: row.next_due_at,
    lastDueAt: row.last_due_at,
    lastCompletedAt: row.last_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateOccurrence(row: RawOccurrenceRow): PulseOccurrence {
  return {
    id: row.id,
    itemId: row.item_id,
    scheduledFor: row.scheduled_for,
    status: isPulseOccurrenceStatus(row.status) ? row.status : "queued",
    attemptCount: Number(row.attempt_count ?? 0),
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    availableAt: row.available_at,
    eventId: row.event_id,
    runId: row.run_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertHistory(
  db: DatabaseSync,
  input: { itemId: string; clientId: string; action: string; detail: Record<string, unknown>; createdAt: string },
): void {
  db.prepare(`
    INSERT INTO pulse_item_history (
      item_id,
      client_id,
      action,
      detail_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(input.itemId, input.clientId, input.action, serializeJson(input.detail), input.createdAt);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(name) as { name?: string } | undefined;
  return row?.name === name;
}

function serializeJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

function parseObjectJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseScheduleJson(raw: string | null): PulseSchedule | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed as unknown as PulseSchedule : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {};
}

function isPulseKind(value: string): value is PulseItemKind {
  return value === "event" || value === "reminder" || value === "notification" || value === "task";
}

function isPulseStatus(value: string): value is PulseItemStatus {
  return value === "active" || value === "paused" || value === "completed" || value === "cancelled";
}

function isPulseExecutionMode(value: string): value is PulseExecutionMode {
  return value === "none" || value === "notify" || value === "run_task";
}

function isPulseOccurrenceStatus(value: string): value is PulseOccurrenceStatus {
  return value === "queued"
    || value === "leased"
    || value === "completed"
    || value === "failed"
    || value === "skipped"
    || value === "dead_lettered";
}

function parseLegacyDocument(filePath: string): PulseStoreDocument | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["reminders"])) {
      return null;
    }
    return parsed as unknown as PulseStoreDocument;
  } catch {
    return null;
  }
}

function legacyReminderToItem(reminder: PulseReminder): PulseItem {
  const kind: PulseItemKind = reminder.intentKind === "task" ? "task" : "reminder";
  return {
    id: reminder.id,
    clientId: reminder.clientId,
    source: "pulse",
    kind,
    status: reminder.status,
    executionMode: defaultExecutionMode(kind),
    title: reminder.title,
    instruction: reminder.instruction,
    timezone: resolveTimeZone(reminder.timezone),
    schedule: normalizeSchedule(reminder.schedule),
    payload: normalizePayload({
      ...(reminder.requestedAction ? { requestedAction: reminder.requestedAction } : {}),
      ...(reminder.task ? { task: reminder.task } : {}),
      ...(reminder.originRunId ? { originRunId: reminder.originRunId } : {}),
      ...(reminder.originSessionId ? { originSessionId: reminder.originSessionId } : {}),
    }, kind),
    metadata: cloneObject(reminder.metadata),
    startAtUtc: null,
    endAtUtc: null,
    durationMs: null,
    allDay: false,
    nextDueAt: reminder.nextTriggerAt,
    lastDueAt: reminder.lastTriggeredAt ?? null,
    lastCompletedAt: reminder.status === "completed" ? reminder.updatedAt : null,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
  };
}
