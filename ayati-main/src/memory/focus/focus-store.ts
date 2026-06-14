import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import type {
  FocusArtifactRef,
  FocusCard,
  FocusScope,
  FocusShelfItem,
  FocusStatus,
  FocusType,
  FocusUpsertInput,
} from "./types.js";
import {
  admitFocus,
  calculateAttentionScore,
  defaultDecayRate,
  defaultMemoryStrength,
  inferFocusType,
  statusFromAttentionScore,
} from "./policy.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");
const SHELF_LIMIT = 5;

export interface FocusStoreOptions {
  dataDir?: string;
  dbPath?: string;
  now?: () => Date;
}

export interface FocusSearchOptions {
  scope?: FocusScope | "all";
  sessionId?: string;
  limit?: number;
}

export interface FocusActivateInput {
  clientId: string;
  focusId: string;
  sessionId: string;
  reason?: string;
}

export interface FocusUpdateInput {
  clientId: string;
  focusId: string;
  summary?: string;
  openWork?: string[];
  verifiedFacts?: string[];
  nextStep?: string;
}

interface FocusRow {
  focus_id: string;
  client_id: string;
  scope: FocusScope;
  session_id: string | null;
  parent_focus_id: string | null;
  type: FocusType;
  status: FocusStatus;
  label: string;
  summary: string;
  shelf_summary: string;
  confidence: number;
  importance: number;
  memory_strength: number;
  decay_rate: number;
  reuse_count: number;
  created_at: string;
  last_touched_at: string;
  attention_until: string | null;
  active_session_id: string | null;
  activated_at: string | null;
  activated_reason: string | null;
  entities_json: string;
  artifacts_json: string;
  verified_facts_json: string;
  open_work_json: string;
  next_step: string | null;
  source_run_ids_json: string;
  details_json: string;
  metadata_json: string;
}

export class FocusStore {
  private readonly dbPath: string;
  private readonly nowProvider: () => Date;
  private db: DatabaseSync | null = null;

  constructor(options?: FocusStoreOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.dbPath = options?.dbPath ?? resolve(dataDir, "memory.sqlite");
    this.nowProvider = options?.now ?? (() => new Date());
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

  upsertFromTaskSummary(input: FocusUpsertInput): FocusCard | null {
    return this.upsertTaskFocus({ ...input, scope: input.scope ?? "global" }, { requireAdmission: true });
  }

  upsertSessionFromTaskSummary(input: FocusUpsertInput & { sessionId: string }): FocusCard {
    const card = this.upsertTaskFocus({ ...input, scope: "session" }, { requireAdmission: false });
    if (!card) {
      throw new Error("Session focus card creation unexpectedly failed.");
    }
    return card;
  }

  promoteSessionCards(clientId: string, sessionId: string): FocusCard[] {
    const cards = this.listCards({ clientId, scope: "session", sessionId, limit: 40 });
    const promoted: FocusCard[] = [];
    for (const card of cards) {
      if (!shouldPromoteSessionCard(card)) {
        continue;
      }
      const input = focusCardToUpsertInput(card);
      const global = this.upsertTaskFocus({
        ...input,
        clientId,
        scope: "global",
        parentFocusId: card.parentFocusId,
        sessionId: undefined,
      }, { requireAdmission: false });
      if (global) {
        promoted.push(global);
      }
    }
    return promoted;
  }

  getSessionShelf(clientId: string, sessionId: string, limit = SHELF_LIMIT): FocusShelfItem[] {
    return this.buildShelf({
      clientId,
      scope: "session",
      sessionId,
      limit,
      minimumScore: 0,
      sort: "session",
    });
  }

  getGlobalShelf(clientId: string, limit = SHELF_LIMIT): FocusShelfItem[] {
    return this.buildShelf({
      clientId,
      scope: "global",
      limit,
      minimumScore: 0.28,
      sort: "attention",
    });
  }

  getActiveFocus(clientId: string, sessionId: string, limit = 3): FocusShelfItem[] {
    const db = this.requireDb();
    const now = this.nowProvider();
    const rows = db.prepare(`
      SELECT *
      FROM focus_items
      WHERE client_id = ? AND active_session_id = ? AND status <> 'archived'
      ORDER BY activated_at DESC, last_touched_at DESC
      LIMIT ?
    `).all(clientId, sessionId, Math.max(1, Math.min(3, limit))) as unknown as FocusRow[];

    return rows.map((row) => {
      const card = this.toFocusCard(row);
      return toShelfItem(card, attentionScoreForCard(card, now), now);
    });
  }

  activateFocus(input: FocusActivateInput): FocusCard | null {
    const card = this.getFocus(input.focusId);
    if (!card || card.clientId !== input.clientId) {
      return null;
    }
    const nowIso = this.nowProvider().toISOString();
    this.requireDb().prepare(`
      UPDATE focus_items
      SET active_session_id = ?, activated_at = ?, activated_reason = ?, last_touched_at = ?
      WHERE focus_id = ? AND client_id = ?
    `).run(input.sessionId, nowIso, input.reason?.trim() || "activated", nowIso, input.focusId, input.clientId);
    this.writeFocusEvent(input.focusId, input.clientId, "focus_activate", input.focusId, nowIso, {
      sessionId: input.sessionId,
      reason: input.reason?.trim() || "activated",
    });
    return this.getFocus(input.focusId);
  }

  deactivateFocus(clientId: string, sessionId: string, focusId?: string): number {
    const db = this.requireDb();
    if (focusId?.trim()) {
      const result = db.prepare(`
        UPDATE focus_items
        SET active_session_id = NULL, activated_at = NULL, activated_reason = NULL
        WHERE client_id = ? AND active_session_id = ? AND focus_id = ?
      `).run(clientId, sessionId, focusId.trim());
      return Number(result.changes ?? 0);
    }
    const result = db.prepare(`
      UPDATE focus_items
      SET active_session_id = NULL, activated_at = NULL, activated_reason = NULL
      WHERE client_id = ? AND active_session_id = ?
    `).run(clientId, sessionId);
    return Number(result.changes ?? 0);
  }

  updateFocus(input: FocusUpdateInput): FocusCard | null {
    const card = this.getFocus(input.focusId);
    if (!card || card.clientId !== input.clientId) {
      return null;
    }
    const next: FocusCard = {
      ...card,
      summary: compactText(input.summary ?? card.summary, 700),
      shelfSummary: compactText(input.summary ?? card.shelfSummary, 180),
      openWork: input.openWork ? compactList(input.openWork, 6, 220) : card.openWork,
      verifiedFacts: input.verifiedFacts
        ? compactList([...card.verifiedFacts, ...input.verifiedFacts], 10, 220)
        : card.verifiedFacts,
      ...(input.nextStep !== undefined
        ? input.nextStep.trim()
          ? { nextStep: compactText(input.nextStep, 220) }
          : {}
        : card.nextStep ? { nextStep: card.nextStep } : {}),
      lastTouchedAt: this.nowProvider().toISOString(),
    };
    this.writeCard(next, "updated_by_tool", input.focusId, { source: "focus_update" });
    return this.getFocus(input.focusId);
  }

  private upsertTaskFocus(input: FocusUpsertInput, options: { requireAdmission: boolean }): FocusCard | null {
    const type = inferFocusType(input);
    const admission = admitFocus(input, type);
    if (options.requireAdmission && !admission.admitted) {
      return null;
    }

    const now = new Date(input.createdAt);
    const scope = input.scope ?? "global";
    const sessionId = scope === "session" ? input.sessionId : undefined;
    const label = buildLabel(input, type);
    const entities = uniqueStrings([
      ...tokenizeLabel(label),
      ...(input.entityHints ?? []),
      ...(input.attachmentNames ?? []),
    ]).slice(0, 12);
    const artifacts = collectArtifacts(input);
    const existing = this.findIdentityMatch(input.clientId, scope, sessionId, label, entities, artifacts);
    const previous = existing ? this.toFocusCard(existing) : null;
    const sourceRunIds = uniqueStrings([...(previous?.sourceRunIds ?? []), input.runId]).slice(-12);
    const openWork = compactList([...(input.openWork ?? []), ...(input.blockers ?? [])], 6, 220);
    const verifiedFacts = compactList([
      ...(previous?.verifiedFacts ?? []),
      ...(input.keyFacts ?? []),
      ...(input.evidence ?? []),
      ...(input.completedMilestones ?? []),
    ], 10, 220);
    const summary = buildSummary(input, previous?.summary);
    const shelfSummary = compactText(summary, 180);
    const memoryStrength = Math.min(1, Math.max(defaultMemoryStrength(type), (previous?.memoryStrength ?? 0) + 0.08));
    const decayRate = previous?.decayRate ?? defaultDecayRate(type);
    const importance = Math.max(previous?.importance ?? defaultImportance(type), inferImportance(input, type));
    const reuseCount = previous ? previous.reuseCount + 1 : 1;
    const attentionScore = calculateAttentionScore({
      memoryStrength,
      decayRate,
      importance,
      reuseCount,
      lastTouchedAt: input.createdAt,
      openWorkCount: openWork.length,
      now,
    });
    const status = statusFromAttentionScore(attentionScore);
    const focusId = previous?.focusId ?? stableFocusId(input.clientId, label, type, scope, sessionId);
    const details = buildDetails(input, type, previous?.details ?? {});
    const card: FocusCard = {
      focusId,
      clientId: input.clientId,
      scope,
      ...(sessionId ? { sessionId } : {}),
      ...(input.parentFocusId ?? previous?.parentFocusId ? { parentFocusId: input.parentFocusId ?? previous?.parentFocusId } : {}),
      type,
      status,
      label,
      summary,
      shelfSummary,
      entities,
      artifacts: mergeArtifacts(previous?.artifacts ?? [], artifacts).slice(0, 16),
      verifiedFacts,
      openWork,
      ...(input.nextAction ? { nextStep: compactText(input.nextAction, 220) } : previous?.nextStep ? { nextStep: previous.nextStep } : {}),
      sourceRunIds,
      memoryStrength,
      decayRate,
      importance,
      reuseCount,
      createdAt: previous?.createdAt ?? input.createdAt,
      lastTouchedAt: input.createdAt,
      attentionUntil: estimateAttentionUntil(input.createdAt, decayRate, memoryStrength),
      ...(previous?.activeSessionId ? { activeSessionId: previous.activeSessionId } : {}),
      ...(previous?.activatedAt ? { activatedAt: previous.activatedAt } : {}),
      ...(previous?.activatedReason ? { activatedReason: previous.activatedReason } : {}),
      details,
    };

    this.writeCard(card, previous ? "updated" : "created", input.runId, {
      admissionScore: admission.score,
      admissionReason: admission.reason,
      runPath: input.runPath,
    });
    return card;
  }

  getShelf(clientId: string, limit = SHELF_LIMIT): FocusShelfItem[] {
    return this.getGlobalShelf(clientId, limit);
  }

  getFocus(focusId: string): FocusCard | null {
    const row = this.requireDb().prepare("SELECT * FROM focus_items WHERE focus_id = ?").get(focusId) as FocusRow | undefined;
    return row ? this.toFocusCard(row) : null;
  }

  search(clientId: string, query: string, limitOrOptions: number | FocusSearchOptions = 5): FocusShelfItem[] {
    const options: FocusSearchOptions = typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : limitOrOptions;
    const limit = options.limit ?? 5;
    const terms = tokenize(query);
    if (terms.length === 0) {
      return [];
    }
    const pattern = `%${terms[0] ?? ""}%`;
    const filters = [
      "fi.client_id = ?",
      "fs.searchable_text LIKE ?",
      "fi.status <> 'archived'",
      ...(options.scope && options.scope !== "all" ? ["fi.scope = ?"] : []),
      ...(options.sessionId ? ["fi.session_id = ?"] : []),
    ];
    const params: SQLInputValue[] = [
      clientId,
      pattern,
      ...(options.scope && options.scope !== "all" ? [options.scope] : []),
      ...(options.sessionId ? [options.sessionId] : []),
      Math.max(1, Math.min(20, limit * 4)),
    ];
    const rows = this.requireDb().prepare(`
      SELECT fi.*
      FROM focus_search fs
      JOIN focus_items fi ON fi.focus_id = fs.focus_id
      WHERE ${filters.join(" AND ")}
      ORDER BY fi.last_touched_at DESC
      LIMIT ?
    `).all(...params) as unknown as FocusRow[];
    const now = this.nowProvider();
    return rows
      .map((row) => this.toFocusCard(row))
      .map((card) => ({
        card,
        score: tokenOverlapScore(terms, searchableText(card)),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.card.lastTouchedAt.localeCompare(a.card.lastTouchedAt))
      .slice(0, limit)
      .map(({ card, score }) => toShelfItem(card, score, now));
  }

  listCards(input: {
    clientId: string;
    scope?: FocusScope | "all";
    sessionId?: string;
    limit?: number;
  }): FocusCard[] {
    const filters = [
      "client_id = ?",
      "status <> 'archived'",
      ...(input.scope && input.scope !== "all" ? ["scope = ?"] : []),
      ...(input.sessionId ? ["session_id = ?"] : []),
    ];
    const params: SQLInputValue[] = [
      input.clientId,
      ...(input.scope && input.scope !== "all" ? [input.scope] : []),
      ...(input.sessionId ? [input.sessionId] : []),
      Math.max(1, Math.min(50, input.limit ?? 20)),
    ];
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM focus_items
      WHERE ${filters.join(" AND ")}
      ORDER BY last_touched_at DESC
      LIMIT ?
    `).all(...params) as unknown as FocusRow[];
    return rows.map((row) => this.toFocusCard(row));
  }

  private buildShelf(input: {
    clientId: string;
    scope: FocusScope;
    sessionId?: string;
    limit: number;
    minimumScore: number;
    sort: "attention" | "session";
  }): FocusShelfItem[] {
    const now = this.nowProvider();
    const cards = this.listCards({
      clientId: input.clientId,
      scope: input.scope,
      sessionId: input.sessionId,
      limit: 40,
    });
    return cards
      .map((card) => ({
        card,
        score: attentionScoreForCard(card, now),
      }))
      .filter(({ score }) => score >= input.minimumScore)
      .sort((a, b) => {
        if (input.sort === "session") {
          const sessionScore = sessionContextScore(b.card, b.score) - sessionContextScore(a.card, a.score);
          return sessionScore || b.card.lastTouchedAt.localeCompare(a.card.lastTouchedAt);
        }
        return b.score - a.score || b.card.lastTouchedAt.localeCompare(a.card.lastTouchedAt);
      })
      .slice(0, Math.max(1, Math.min(12, input.limit)))
      .map(({ card, score }) => toShelfItem(card, score, now));
  }

  private writeCard(card: FocusCard, eventType: string, runId: string, metadata: Record<string, unknown>): void {
    const db = this.requireDb();
    const row = [
      card.focusId,
      card.clientId,
      card.scope,
      card.sessionId ?? null,
      card.parentFocusId ?? null,
      card.type,
      card.status,
      card.label,
      card.summary,
      card.shelfSummary,
      1,
      card.importance,
      card.memoryStrength,
      card.decayRate,
      card.reuseCount,
      card.createdAt,
      card.lastTouchedAt,
      card.attentionUntil ?? null,
      card.activeSessionId ?? null,
      card.activatedAt ?? null,
      card.activatedReason ?? null,
      JSON.stringify(card.entities),
      JSON.stringify(card.artifacts),
      JSON.stringify(card.verifiedFacts),
      JSON.stringify(card.openWork),
      card.nextStep ?? null,
      JSON.stringify(card.sourceRunIds),
      JSON.stringify(card.details),
      JSON.stringify(metadata),
    ];
    db.prepare(`
      INSERT INTO focus_items (
        focus_id, client_id, scope, session_id, parent_focus_id,
        type, status, label, summary, shelf_summary,
        confidence, importance, memory_strength, decay_rate, reuse_count,
        created_at, last_touched_at, attention_until,
        active_session_id, activated_at, activated_reason, entities_json,
        artifacts_json, verified_facts_json, open_work_json, next_step,
        source_run_ids_json, details_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(focus_id) DO UPDATE SET
        scope = excluded.scope,
        session_id = excluded.session_id,
        parent_focus_id = excluded.parent_focus_id,
        status = excluded.status,
        label = excluded.label,
        summary = excluded.summary,
        shelf_summary = excluded.shelf_summary,
        confidence = excluded.confidence,
        importance = excluded.importance,
        memory_strength = excluded.memory_strength,
        decay_rate = excluded.decay_rate,
        reuse_count = excluded.reuse_count,
        last_touched_at = excluded.last_touched_at,
        attention_until = excluded.attention_until,
        active_session_id = excluded.active_session_id,
        activated_at = excluded.activated_at,
        activated_reason = excluded.activated_reason,
        entities_json = excluded.entities_json,
        artifacts_json = excluded.artifacts_json,
        verified_facts_json = excluded.verified_facts_json,
        open_work_json = excluded.open_work_json,
        next_step = excluded.next_step,
        source_run_ids_json = excluded.source_run_ids_json,
        details_json = excluded.details_json,
        metadata_json = excluded.metadata_json
    `).run(...row);

    db.prepare(`
      INSERT INTO focus_search (focus_id, client_id, searchable_text, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(focus_id) DO UPDATE SET
        searchable_text = excluded.searchable_text,
        updated_at = excluded.updated_at
    `).run(card.focusId, card.clientId, searchableText(card), card.lastTouchedAt);

    db.prepare(`
      INSERT INTO focus_events (id, focus_id, client_id, run_id, event_type, delta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), card.focusId, card.clientId, runId, eventType, JSON.stringify(metadata), card.lastTouchedAt);
  }

  private writeFocusEvent(
    focusId: string,
    clientId: string,
    eventType: string,
    runId: string,
    createdAt: string,
    metadata: Record<string, unknown>,
  ): void {
    this.requireDb().prepare(`
      INSERT INTO focus_events (id, focus_id, client_id, run_id, event_type, delta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), focusId, clientId, runId, eventType, JSON.stringify(metadata), createdAt);
  }

  private findIdentityMatch(
    clientId: string,
    scope: FocusScope,
    sessionId: string | undefined,
    label: string,
    entities: string[],
    artifacts: FocusArtifactRef[],
  ): FocusRow | null {
    const db = this.requireDb();
    const artifactPaths = artifacts
      .map((artifact) => artifact.path ?? artifact.documentId ?? artifact.displayName)
      .filter((value): value is string => Boolean(value));
    for (const artifact of artifactPaths) {
      const row = db.prepare(`
        SELECT *
        FROM focus_items
        WHERE client_id = ? AND scope = ? AND ${scope === "session" ? "session_id = ?" : "session_id IS NULL"} AND artifacts_json LIKE ?
        ORDER BY last_touched_at DESC
        LIMIT 1
      `).get(...identityParams(clientId, scope, sessionId, `%${escapeLike(artifact)}%`)) as FocusRow | undefined;
      if (row) return row;
    }

    const labelMatch = db.prepare(`
      SELECT *
      FROM focus_items
      WHERE client_id = ? AND scope = ? AND ${scope === "session" ? "session_id = ?" : "session_id IS NULL"} AND lower(label) = lower(?)
      ORDER BY last_touched_at DESC
      LIMIT 1
    `).get(...identityParams(clientId, scope, sessionId, label)) as FocusRow | undefined;
    if (labelMatch) return labelMatch;

    for (const entity of entities.slice(0, 4)) {
      const row = db.prepare(`
        SELECT *
        FROM focus_items
        WHERE client_id = ? AND scope = ? AND ${scope === "session" ? "session_id = ?" : "session_id IS NULL"} AND entities_json LIKE ?
        ORDER BY last_touched_at DESC
        LIMIT 1
      `).get(...identityParams(clientId, scope, sessionId, `%${escapeLike(entity)}%`)) as FocusRow | undefined;
      if (row) return row;
    }
    return null;
  }

  private toFocusCard(row: FocusRow): FocusCard {
    return {
      focusId: row.focus_id,
      clientId: row.client_id,
      scope: normalizeFocusScope(row.scope),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.parent_focus_id ? { parentFocusId: row.parent_focus_id } : {}),
      type: row.type,
      status: row.status,
      label: row.label,
      summary: row.summary,
      shelfSummary: row.shelf_summary,
      entities: parseStringArray(row.entities_json),
      artifacts: parseJsonArray<FocusArtifactRef>(row.artifacts_json),
      verifiedFacts: parseStringArray(row.verified_facts_json),
      openWork: parseStringArray(row.open_work_json),
      ...(row.next_step ? { nextStep: row.next_step } : {}),
      sourceRunIds: parseStringArray(row.source_run_ids_json),
      memoryStrength: row.memory_strength,
      decayRate: row.decay_rate,
      importance: row.importance,
      reuseCount: row.reuse_count,
      createdAt: row.created_at,
      lastTouchedAt: row.last_touched_at,
      ...(row.attention_until ? { attentionUntil: row.attention_until } : {}),
      ...(row.active_session_id ? { activeSessionId: row.active_session_id } : {}),
      ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
      ...(row.activated_reason ? { activatedReason: row.activated_reason } : {}),
      details: parseJsonObject(row.details_json),
    };
  }

  private createSchema(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS focus_items (
        focus_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        session_id TEXT,
        parent_focus_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        label TEXT NOT NULL,
        summary TEXT NOT NULL,
        shelf_summary TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        importance REAL NOT NULL DEFAULT 0.5,
        memory_strength REAL NOT NULL,
        decay_rate REAL NOT NULL,
        reuse_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_touched_at TEXT NOT NULL,
        attention_until TEXT,
        active_session_id TEXT,
        activated_at TEXT,
        activated_reason TEXT,
        entities_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        verified_facts_json TEXT NOT NULL,
        open_work_json TEXT NOT NULL,
        next_step TEXT,
        source_run_ids_json TEXT NOT NULL,
        details_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_focus_items_client_status_recent
        ON focus_items(client_id, status, last_touched_at DESC);

      CREATE TABLE IF NOT EXISTS focus_events (
        id TEXT PRIMARY KEY,
        focus_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        delta_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_focus_events_focus_created
        ON focus_events(focus_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS focus_search (
        focus_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        searchable_text TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_focus_search_client
        ON focus_search(client_id);
    `);
    this.ensureColumn("focus_items", "scope", "TEXT NOT NULL DEFAULT 'global'");
    this.ensureColumn("focus_items", "session_id", "TEXT");
    this.ensureColumn("focus_items", "parent_focus_id", "TEXT");
    this.ensureColumn("focus_items", "active_session_id", "TEXT");
    this.ensureColumn("focus_items", "activated_at", "TEXT");
    this.ensureColumn("focus_items", "activated_reason", "TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_focus_items_scope_session_recent
        ON focus_items(client_id, scope, session_id, status, last_touched_at DESC);

      CREATE INDEX IF NOT EXISTS idx_focus_items_active_session
        ON focus_items(client_id, active_session_id, activated_at DESC);
    `);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("FocusStore not started");
    }
    return this.db;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const db = this.requireDb();
    const columns = db.prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => String((row as Record<string, unknown>)["name"]));
    if (columns.includes(column)) {
      return;
    }
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function buildLabel(input: FocusUpsertInput, type: FocusType): string {
  const candidates = [
    input.currentFocus,
    input.objective,
    input.entityHints?.[0],
    input.attachmentNames?.[0],
    input.userMessage,
    input.summary,
  ];
  const raw = candidates.find((candidate) => candidate && candidate.trim().length > 0) ?? type;
  return compactText(raw, 64);
}

function buildSummary(input: FocusUpsertInput, previousSummary?: string): string {
  const parts = uniqueStrings([
    previousSummary,
    input.progressSummary,
    input.summary,
    ...(input.completedMilestones ?? []),
  ].filter((value): value is string => Boolean(value && value.trim())));
  return compactText(parts.join(" "), 700);
}

function buildDetails(
  input: FocusUpsertInput,
  type: FocusType,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "learning") {
    return {
      ...previous,
      currentPosition: input.currentFocus ?? previous["currentPosition"],
      knownSoFar: compactList([...(readStringArray(previous["knownSoFar"])), ...(input.completedMilestones ?? []), ...(input.keyFacts ?? [])], 8, 160),
      weakSpots: compactList([...(readStringArray(previous["weakSpots"])), ...(input.blockers ?? [])], 6, 160),
      nextStep: input.nextAction ?? previous["nextStep"],
    };
  }
  if (type === "document") {
    return {
      ...previous,
      documentNames: uniqueStrings([...(readStringArray(previous["documentNames"])), ...(input.attachmentNames ?? [])]).slice(0, 8),
    };
  }
  if (type === "debug_issue") {
    return {
      ...previous,
      symptoms: compactList([...(readStringArray(previous["symptoms"])), ...(input.blockers ?? [])], 6, 180),
      attemptsTried: compactList([...(readStringArray(previous["attemptsTried"])), ...(input.completedMilestones ?? [])], 8, 180),
      nextDiagnosticStep: input.nextAction ?? previous["nextDiagnosticStep"],
    };
  }
  return previous;
}

function collectArtifacts(input: FocusUpsertInput): FocusArtifactRef[] {
  const attachmentArtifacts: FocusArtifactRef[] = (input.activeAttachments ?? []).map((attachment) => ({
    kind: "document",
    documentId: attachment.documentId,
    displayName: attachment.displayName,
    preparedInputId: attachment.preparedInputId,
    manifestPath: attachment.manifest?.path,
    role: "source document",
    sourceRunId: attachment.runId,
    sourceRunPath: attachment.runPath,
    lastUsedAt: attachment.lastUsedAt,
  }));

  const mentioned = extractPathLikeArtifacts([
    input.summary,
    input.progressSummary,
    ...(input.evidence ?? []),
    ...(input.keyFacts ?? []),
    ...(input.completedMilestones ?? []),
  ].join("\n"), input.runId, input.runPath);

  return mergeArtifacts(attachmentArtifacts, mentioned);
}

function extractPathLikeArtifacts(text: string, runId: string, runPath: string): FocusArtifactRef[] {
  const matches = text.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|txt|html|css|py|sql|csv|pdf|png|jpg|jpeg|svg)/g) ?? [];
  return uniqueStrings(matches)
    .slice(0, 12)
    .map((path) => ({
      kind: path.toLowerCase().endsWith(".pdf") ? "document" : "file",
      path,
      role: "referenced artifact",
      sourceRunId: runId,
      sourceRunPath: runPath,
    }));
}

function mergeArtifacts(left: FocusArtifactRef[], right: FocusArtifactRef[]): FocusArtifactRef[] {
  const seen = new Set<string>();
  const output: FocusArtifactRef[] = [];
  for (const artifact of [...left, ...right]) {
    const key = artifact.path ?? artifact.documentId ?? artifact.displayName ?? artifact.uri;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(artifact);
  }
  return output;
}

function toShelfItem(card: FocusCard, score: number, now: Date): FocusShelfItem {
  return {
    focusId: card.focusId,
    scope: card.scope,
    ...(card.sessionId ? { sessionId: card.sessionId } : {}),
    ...(card.parentFocusId ? { parentFocusId: card.parentFocusId } : {}),
    type: card.type,
    status: statusFromAttentionScore(score),
    label: card.label,
    summary: card.shelfSummary,
    hints: card.entities.slice(0, 8),
    topArtifacts: card.artifacts
      .map((artifact) => artifact.path ?? artifact.displayName ?? artifact.documentId ?? artifact.uri ?? "")
      .filter(Boolean)
      .slice(0, 5),
    openWork: card.openWork.slice(0, 5),
    lastTouchedAt: card.lastTouchedAt,
    lastTouchedLabel: formatRelativeAge(card.lastTouchedAt, now),
    attentionScore: score,
    ...(card.nextStep ? { nextStep: card.nextStep } : {}),
    ...(card.activeSessionId ? { activeSessionId: card.activeSessionId } : {}),
    ...(card.activatedAt ? { activatedAt: card.activatedAt } : {}),
    ...(card.activatedReason ? { activatedReason: card.activatedReason } : {}),
  };
}

function stableFocusId(clientId: string, label: string, type: FocusType, scope: FocusScope, sessionId: string | undefined): string {
  const scopeKey = scope === "session" ? `session:${sessionId ?? "unknown"}` : "global";
  const hash = createHash("sha256").update(`${clientId}:${scopeKey}:${type}:${normalizeId(label)}`).digest("hex").slice(0, 20);
  return `focus_${hash}`;
}

function attentionScoreForCard(card: FocusCard, now: Date): number {
  return calculateAttentionScore({
    memoryStrength: card.memoryStrength,
    decayRate: card.decayRate,
    importance: card.importance,
    reuseCount: card.reuseCount,
    lastTouchedAt: card.lastTouchedAt,
    openWorkCount: card.openWork.length,
    now,
  });
}

function sessionContextScore(card: FocusCard, attentionScore: number): number {
  const openWorkBoost = card.openWork.length > 0 ? 0.35 : 0;
  const nextStepBoost = card.nextStep ? 0.2 : 0;
  const artifactBoost = card.artifacts.length > 0 ? 0.18 : 0;
  const factBoost = card.verifiedFacts.length > 0 ? 0.12 : 0;
  const activeBoost = card.activeSessionId ? 0.25 : 0;
  return attentionScore + openWorkBoost + nextStepBoost + artifactBoost + factBoost + activeBoost;
}

function normalizeFocusScope(scope: string): FocusScope {
  return scope === "session" ? "session" : "global";
}

function identityParams(clientId: string, scope: FocusScope, sessionId: string | undefined, value: string): SQLInputValue[] {
  return scope === "session"
    ? [clientId, scope, sessionId ?? "", value]
    : [clientId, scope, value];
}

function focusCardToUpsertInput(card: FocusCard): FocusUpsertInput {
  const latestRunId = card.sourceRunIds[card.sourceRunIds.length - 1] ?? card.focusId;
  const latestArtifact = card.artifacts.find((artifact) => artifact.sourceRunPath);
  return {
    clientId: card.clientId,
    runId: latestRunId,
    runPath: latestArtifact?.sourceRunPath ?? "",
    status: "completed",
    taskStatus: card.openWork.length > 0 ? "not_done" : "likely_done",
    objective: card.label,
    summary: card.summary,
    progressSummary: card.shelfSummary,
    currentFocus: card.label,
    openWork: card.openWork,
    keyFacts: card.verifiedFacts,
    evidence: card.verifiedFacts,
    nextAction: card.nextStep,
    entityHints: card.entities,
    attachmentNames: card.artifacts
      .map((artifact) => artifact.displayName ?? artifact.path ?? artifact.documentId)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    activeAttachments: card.artifacts
      .filter((artifact) => artifact.kind === "document" && artifact.documentId && artifact.displayName && artifact.preparedInputId)
      .map((artifact) => ({
        documentId: artifact.documentId!,
        displayName: artifact.displayName!,
        kind: "document",
        mode: "restored",
        runId: artifact.sourceRunId ?? latestRunId,
        runPath: artifact.sourceRunPath ?? "",
        preparedInputId: artifact.preparedInputId!,
        lastUsedAt: artifact.lastUsedAt ?? card.lastTouchedAt,
      })),
    createdAt: card.lastTouchedAt,
  };
}

function shouldPromoteSessionCard(card: FocusCard): boolean {
  if (card.openWork.length > 0 || card.artifacts.length > 0 || card.verifiedFacts.length > 0 || card.nextStep) {
    return true;
  }
  return card.type === "learning"
    || card.type === "automation"
    || card.type === "document"
    || card.type === "debug_issue"
    || card.type === "investigation"
    || card.reuseCount > 1;
}

function estimateAttentionUntil(lastTouchedAt: string, decayRate: number, strength: number): string {
  const base = Date.parse(lastTouchedAt);
  const threshold = 0.28;
  const days = Math.max(1, Math.min(365, Math.log(Math.max(strength, threshold) / threshold) / Math.max(decayRate, 0.001)));
  return new Date(base + days * 86_400_000).toISOString();
}

function searchableText(card: FocusCard): string {
  return [
    card.scope,
    card.sessionId,
    card.label,
    card.summary,
    card.shelfSummary,
    ...card.entities,
    ...card.openWork,
    ...card.verifiedFacts,
    ...card.artifacts.map((artifact) => artifact.path ?? artifact.displayName ?? artifact.documentId ?? ""),
  ].join("\n").toLowerCase();
}

function tokenOverlapScore(tokens: string[], text: string): number {
  const haystack = new Set(tokenize(text));
  if (tokens.length === 0 || haystack.size === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.has(token)) hits++;
  }
  return Number((hits / tokens.length).toFixed(4));
}

function tokenize(value: string): string[] {
  return uniqueStrings((value.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? []).filter((token) => !STOPWORDS.has(token)));
}

function tokenizeLabel(value: string): string[] {
  return tokenize(value).slice(0, 6);
}

function compactList(values: string[], count: number, chars: number): string[] {
  return uniqueStrings(values)
    .map((value) => compactText(value, chars))
    .filter(Boolean)
    .slice(0, count);
}

function compactText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const compact = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!compact) continue;
    const key = compact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(compact);
  }
  return output;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string): string[] {
  return parseJsonArray<unknown>(value).filter((item): item is string => typeof item === "string");
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function defaultImportance(type: FocusType): number {
  switch (type) {
    case "automation":
    case "learning":
      return 0.8;
    case "artifact_work":
      return 0.7;
    case "document":
    case "investigation":
      return 0.62;
    case "debug_issue":
      return 0.58;
    case "generic_task":
      return 0.45;
  }
}

function inferImportance(input: FocusUpsertInput, type: FocusType): number {
  let value = defaultImportance(type);
  if ((input.openWork?.length ?? 0) > 0) value += 0.1;
  if ((input.activeAttachments?.length ?? 0) > 0) value += 0.08;
  if ((input.completedMilestones?.length ?? 0) > 2) value += 0.05;
  return Math.min(1, value);
}

function formatRelativeAge(iso: string, now: Date): string {
  const ageMs = Math.max(0, now.getTime() - Date.parse(iso));
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "focus";
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, "");
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "about",
  "what",
  "when",
  "where",
  "how",
  "why",
  "into",
  "again",
  "continue",
]);
