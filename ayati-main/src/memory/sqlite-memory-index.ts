import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  SessionProfile,
  SessionSummaryRecord,
  SessionSummarySearchHit,
} from "./types.js";
import { devWarn } from "../shared/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function normalizeKeyword(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._/-\s]/g, "")
    .replace(/\s+/g, " ");
}

function tokenizeQuery(query: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "for",
    "from",
    "has",
    "have",
    "i",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "to",
    "was",
    "were",
    "with",
  ]);

  const unique = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const cleaned = normalizeKeyword(raw);
    if (cleaned.length < 2) continue;
    if (stopwords.has(cleaned)) continue;
    unique.add(cleaned);
  }

  return [...unique].slice(0, 12);
}

export interface PersistedSessionSummaryInput {
  sessionId: string;
  clientId: string;
  createdAt: string;
  closedAt: string;
  closeReason: string;
  tokenCount: number;
  sourcePath: string;
  record: SessionSummaryRecord;
}

export interface SqliteMemoryIndexOptions {
  dataDir?: string;
  dbPath?: string;
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

  getLatestSummary(clientId: string): SessionSummaryRecord | null {
    const db = this.requireDb();
    const row = db
      .prepare(`
        SELECT summary_text, keyword_csv, confidence, redaction_flags
        FROM session_summaries
        WHERE client_id = ?
        ORDER BY closed_at DESC
        LIMIT 1
      `)
      .get(clientId) as
      | {
          summary_text: string;
          keyword_csv: string;
          confidence: number;
          redaction_flags: string;
        }
      | undefined;

    if (!row) return null;
    return {
      summaryText: row.summary_text,
      keywords: row.keyword_csv
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
      confidence: Number(row.confidence) || 0,
      redactionFlags: parseJsonArray(row.redaction_flags),
    };
  }

  upsertSessionSummary(input: PersistedSessionSummaryInput): void {
    const db = this.requireDb();
    const record = input.record;
    const keywordCsv = record.keywords.join(",");
    const redactionFlags = JSON.stringify(record.redactionFlags);
    const before = db
      .prepare("SELECT id, summary_text FROM session_summaries WHERE session_id = ?")
      .get(input.sessionId) as { id: number; summary_text: string } | undefined;

    if (before) {
      db.prepare(`
        UPDATE session_summaries
        SET client_id = ?, created_at = ?, closed_at = ?, close_reason = ?, summary_text = ?, confidence = ?, keyword_csv = ?, token_count = ?, redaction_flags = ?, source_path = ?
        WHERE session_id = ?
      `).run(
        input.clientId,
        input.createdAt,
        input.closedAt,
        input.closeReason,
        record.summaryText,
        record.confidence,
        keywordCsv,
        input.tokenCount,
        redactionFlags,
        input.sourcePath,
        input.sessionId,
      );
    } else {
      db.prepare(`
        INSERT INTO session_summaries
          (session_id, client_id, created_at, closed_at, close_reason, summary_text, confidence, keyword_csv, token_count, redaction_flags, source_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.clientId,
        input.createdAt,
        input.closedAt,
        input.closeReason,
        record.summaryText,
        record.confidence,
        keywordCsv,
        input.tokenCount,
        redactionFlags,
        input.sourcePath,
      );
    }

    db.prepare("DELETE FROM summary_keywords WHERE session_id = ?").run(input.sessionId);
    const insertKeyword = db.prepare(`
      INSERT INTO summary_keywords (session_id, keyword, weight)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, keyword) DO UPDATE SET weight = excluded.weight
    `);
    for (const keyword of record.keywords) {
      insertKeyword.run(input.sessionId, keyword, 1);
    }

    const mutationType = before ? "update_summary" : "create_summary";
    const beforeHash = before ? this.hashString(before.summary_text) : null;
    const afterHash = this.hashString(record.summaryText);
    db.prepare(`
      INSERT INTO memory_mutations
        (session_id, mutation_type, before_hash, after_hash, trigger, model_confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      mutationType,
      beforeHash,
      afterHash,
      input.closeReason,
      record.confidence,
      input.closedAt,
    );
  }

  upsertSessionMetadata(sessionId: string, profile: SessionProfile): void {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO session_metadata
        (session_id, version, title, scope, keywords_json, anchors_json, subtopics_json, active_goals_json, constraints_json, stable_entities_json, decision_log_json, open_loops_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        version = excluded.version,
        title = excluded.title,
        scope = excluded.scope,
        keywords_json = excluded.keywords_json,
        anchors_json = excluded.anchors_json,
        subtopics_json = excluded.subtopics_json,
        active_goals_json = excluded.active_goals_json,
        constraints_json = excluded.constraints_json,
        stable_entities_json = excluded.stable_entities_json,
        decision_log_json = excluded.decision_log_json,
        open_loops_json = excluded.open_loops_json,
        updated_at = excluded.updated_at
    `).run(
      sessionId,
      profile.version,
      profile.title,
      profile.scope,
      JSON.stringify(profile.keywords),
      JSON.stringify(profile.anchors),
      JSON.stringify(profile.subtopics),
      JSON.stringify(profile.activeGoals),
      JSON.stringify(profile.constraints),
      JSON.stringify(profile.stableEntities),
      JSON.stringify(profile.decisionLog),
      JSON.stringify(profile.openLoops),
      profile.updatedAt,
    );
  }

  getSessionMetadata(sessionId: string): SessionProfile | null {
    const db = this.requireDb();
    const row = db
      .prepare(`
        SELECT
          version, title, scope, keywords_json, anchors_json, subtopics_json, active_goals_json,
          constraints_json, stable_entities_json, decision_log_json, open_loops_json, updated_at
        FROM session_metadata
        WHERE session_id = ?
      `)
      .get(sessionId) as
      | {
          version: number;
          title: string;
          scope: string;
          keywords_json: string;
          anchors_json: string;
          subtopics_json: string;
          active_goals_json: string;
          constraints_json: string;
          stable_entities_json: string;
          decision_log_json: string;
          open_loops_json: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;
    return {
      title: row.title,
      scope: row.scope,
      keywords: parseJsonArray(row.keywords_json),
      anchors: parseJsonArray(row.anchors_json),
      subtopics: parseJsonArray(row.subtopics_json),
      activeGoals: parseJsonArray(row.active_goals_json),
      constraints: parseJsonArray(row.constraints_json),
      stableEntities: parseJsonArray(row.stable_entities_json),
      decisionLog: parseJsonArray(row.decision_log_json),
      openLoops: parseJsonArray(row.open_loops_json),
      topicConfidence: 1,
      updatedAt: row.updated_at,
      version: Number(row.version) || 1,
    };
  }

  searchSummaries(clientId: string, query: string, limit = 5): SessionSummarySearchHit[] {
    const db = this.requireDb();
    const keywords = tokenizeQuery(query);
    const cappedLimit = Math.max(1, Math.min(20, limit));

    if (keywords.length === 0) {
      const rows = db
        .prepare(`
          SELECT session_id, summary_text, keyword_csv, closed_at, close_reason
          FROM session_summaries
          WHERE client_id = ?
          ORDER BY closed_at DESC
          LIMIT ?
        `)
        .all(clientId, cappedLimit) as Array<{
          session_id: string;
          summary_text: string;
          keyword_csv: string;
          closed_at: string;
          close_reason: string;
        }>;

      return rows.map((row, index) => ({
        sessionId: row.session_id,
        summaryText: row.summary_text,
        keywords: row.keyword_csv.split(",").map((item) => item.trim()).filter(Boolean),
        closedAt: row.closed_at,
        closeReason: row.close_reason,
        score: Math.max(0.01, 1 - index * 0.1),
      }));
    }

    const placeholders = keywords.map(() => "?").join(", ");
    const sql = `
      SELECT
        s.session_id,
        s.summary_text,
        s.keyword_csv,
        s.closed_at,
        s.close_reason,
        COUNT(sk.keyword) AS match_count
      FROM session_summaries s
      LEFT JOIN summary_keywords sk
        ON sk.session_id = s.session_id
       AND sk.keyword IN (${placeholders})
      WHERE s.client_id = ?
      GROUP BY s.session_id, s.summary_text, s.keyword_csv, s.closed_at, s.close_reason
      HAVING match_count > 0 OR LOWER(s.summary_text) LIKE ?
      ORDER BY match_count DESC, s.closed_at DESC
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(
      ...keywords,
      clientId,
      `%${query.toLowerCase()}%`,
      cappedLimit,
    ) as Array<{
      session_id: string;
      summary_text: string;
      keyword_csv: string;
      closed_at: string;
      close_reason: string;
      match_count: number;
    }>;

    return rows.map((row) => ({
      sessionId: row.session_id,
      summaryText: row.summary_text,
      keywords: row.keyword_csv.split(",").map((item) => item.trim()).filter(Boolean),
      closedAt: row.closed_at,
      closeReason: row.close_reason,
      score: Number(row.match_count) || 0.01,
    }));
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("SqliteMemoryIndex not started");
    }
    return this.db;
  }

  private createSchema(): void {
    const db = this.requireDb();
    try {
      db.exec(`
        DROP TABLE IF EXISTS icm_links;
        DROP TABLE IF EXISTS icm_tasks;

        CREATE TABLE IF NOT EXISTS session_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          closed_at TEXT NOT NULL,
          close_reason TEXT NOT NULL,
          summary_text TEXT NOT NULL,
          confidence REAL NOT NULL,
          keyword_csv TEXT NOT NULL,
          token_count INTEGER NOT NULL,
          redaction_flags TEXT NOT NULL,
          source_path TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS summary_keywords (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          keyword TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1,
          UNIQUE(session_id, keyword)
        );
        CREATE INDEX IF NOT EXISTS idx_summary_keywords_keyword
          ON summary_keywords(keyword);

        CREATE TABLE IF NOT EXISTS session_metadata (
          session_id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          title TEXT NOT NULL,
          scope TEXT NOT NULL,
          keywords_json TEXT NOT NULL,
          anchors_json TEXT NOT NULL,
          subtopics_json TEXT NOT NULL,
          active_goals_json TEXT NOT NULL,
          constraints_json TEXT NOT NULL,
          stable_entities_json TEXT NOT NULL,
          decision_log_json TEXT NOT NULL,
          open_loops_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_mutations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          mutation_type TEXT NOT NULL,
          before_hash TEXT,
          after_hash TEXT NOT NULL,
          trigger TEXT NOT NULL,
          model_confidence REAL NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    } catch (err) {
      devWarn(
        "SQLite memory schema initialization failed:",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  private hashString(value: string): string {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
    }
    return `${hash >>> 0}`;
  }
}
