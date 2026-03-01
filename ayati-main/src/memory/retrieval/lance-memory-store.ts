import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  RecallMemoryMatch,
  RecallMemoryRecord,
  RecallSearchInput,
  SummaryVectorStore,
} from "./types.js";

export interface LanceMemoryStoreOptions {
  dataDir?: string;
  tableName?: string;
  fallbackFileName?: string;
}

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data", "memory", "retrieval");

export class LanceMemoryStore implements SummaryVectorStore {
  private readonly dataDir: string;
  private readonly tableName: string;
  private readonly fallbackFilePath: string;
  private lanceDisabled = false;

  constructor(options?: LanceMemoryStoreOptions) {
    this.dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.tableName = options?.tableName ?? "recall_memory";
    this.fallbackFilePath = resolve(this.dataDir, options?.fallbackFileName ?? "recall-memory.json");
  }

  async upsert(record: RecallMemoryRecord): Promise<void> {
    const usedLance = await this.tryUpsertWithLance(record);
    if (usedLance) {
      return;
    }

    const records = this.readFallbackRecords();
    const next = records.filter((candidate) => candidate.id !== record.id);
    next.push(record);
    this.writeFallbackRecords(next);
  }

  async search(input: RecallSearchInput): Promise<RecallMemoryMatch[]> {
    const viaLance = await this.trySearchWithLance(input);
    if (viaLance) {
      return viaLance;
    }

    return this.searchFallback(input);
  }

  private async tryUpsertWithLance(record: RecallMemoryRecord): Promise<boolean> {
    const table = await this.getLanceTable() as { delete?: (filter: string) => Promise<void>; add?: (rows: unknown[]) => Promise<void> } | null;
    if (!table) {
      return false;
    }

    try {
      if (typeof table.delete === "function") {
        await table.delete(`id = '${escapeSql(record.id)}'`);
      }
      if (typeof table.add === "function") {
        await table.add([record]);
        return true;
      }
    } catch {
      this.lanceDisabled = true;
    }

    return false;
  }

  private async trySearchWithLance(input: RecallSearchInput): Promise<RecallMemoryMatch[] | null> {
    const table = await this.getLanceTable() as {
      search?: (vector: number[]) => unknown;
      query?: () => unknown;
    } | null;
    if (!table) {
      return null;
    }

    try {
      let query: {
        where?: (clause: string, options?: Record<string, unknown>) => Promise<unknown> | unknown;
        limit?: (value: number) => Promise<unknown> | unknown;
        toArray?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      } | null = input.vector && input.vector.length > 0 && typeof table.search === "function"
        ? table.search(input.vector) as {
            where?: (clause: string, options?: Record<string, unknown>) => Promise<unknown> | unknown;
            limit?: (value: number) => Promise<unknown> | unknown;
            toArray?: () => Promise<unknown>;
            execute?: () => Promise<unknown>;
          }
        : (typeof table.query === "function"
            ? table.query() as {
                where?: (clause: string, options?: Record<string, unknown>) => Promise<unknown> | unknown;
                limit?: (value: number) => Promise<unknown> | unknown;
                toArray?: () => Promise<unknown>;
                execute?: () => Promise<unknown>;
              }
            : null);

      if (!query) {
        return null;
      }

      const whereParts = [`clientId = '${escapeSql(input.clientId)}'`];
      const lower = normalizeLowerBound(input.dateFrom);
      const upper = normalizeUpperBound(input.dateTo);
      if (lower) {
        whereParts.push(`createdAt >= '${escapeSql(lower)}'`);
      }
      if (upper) {
        whereParts.push(`createdAt <= '${escapeSql(upper)}'`);
      }

      if (typeof query.where === "function") {
        query = await query.where(whereParts.join(" AND "), { prefilter: true }) as typeof query;
      }
      if (typeof query.limit === "function") {
        query = await query.limit(input.limit) as typeof query;
      }

      const rows = typeof query.toArray === "function"
        ? await query.toArray()
        : (typeof query.execute === "function" ? await query.execute() : null);

      if (!Array.isArray(rows)) {
        return null;
      }

      return rows
        .map((row) => normalizeMatchRow(row))
        .filter((row): row is RecallMemoryMatch => row !== null)
        .slice(0, input.limit);
    } catch {
      this.lanceDisabled = true;
      return null;
    }
  }

  private async getLanceTable(): Promise<unknown | null> {
    if (this.lanceDisabled) {
      return null;
    }

    try {
      const module = await importOptionalModules("@lancedb/lancedb", "lancedb");
      if (!module) {
        this.lanceDisabled = true;
        return null;
      }

      const connect = (module as { connect?: unknown; default?: { connect?: unknown } }).connect
        ?? (module as { default?: { connect?: unknown } }).default?.connect;
      if (typeof connect !== "function") {
        this.lanceDisabled = true;
        return null;
      }

      mkdirSync(this.dataDir, { recursive: true });
      const db = await (connect as (path: string) => Promise<unknown>)(this.dataDir);
      if (db && typeof (db as { openTable?: unknown }).openTable === "function") {
        try {
          return await ((db as { openTable: (name: string) => Promise<unknown> }).openTable(this.tableName));
        } catch {
          if (typeof (db as { createTable?: unknown }).createTable === "function") {
            return await ((db as { createTable: (name: string, rows: unknown[]) => Promise<unknown> }).createTable(
              this.tableName,
              [],
            ));
          }
        }
      }
    } catch {
      this.lanceDisabled = true;
    }

    return null;
  }

  private searchFallback(input: RecallSearchInput): RecallMemoryMatch[] {
    const lower = normalizeLowerBound(input.dateFrom);
    const upper = normalizeUpperBound(input.dateTo);

    const rows = this.readFallbackRecords()
      .filter((record) => record.clientId === input.clientId)
      .filter((record) => (lower ? record.createdAt >= lower : true))
      .filter((record) => (upper ? record.createdAt <= upper : true))
      .map((record) => ({
        record,
        score: input.vector && input.vector.length > 0
          ? cosineSimilarity(input.vector, record.embedding)
          : 1,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return b.record.createdAt.localeCompare(a.record.createdAt);
      })
      .slice(0, input.limit);

    return rows.map(({ record, score }) => ({
      sessionId: record.sessionId,
      sessionPath: record.sessionPath,
      createdAt: record.createdAt,
      sourceType: record.sourceType,
      summaryText: record.summaryText,
      score: Number(score.toFixed(4)),
    }));
  }

  private readFallbackRecords(): RecallMemoryRecord[] {
    if (!existsSync(this.fallbackFilePath)) {
      return [];
    }

    try {
      const raw = readFileSync(this.fallbackFilePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isRecallMemoryRecord);
    } catch {
      return [];
    }
  }

  private writeFallbackRecords(records: RecallMemoryRecord[]): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.fallbackFilePath, JSON.stringify(records, null, 2), "utf8");
  }
}

function normalizeMatchRow(row: unknown): RecallMemoryMatch | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const value = row as Record<string, unknown>;
  if (
    typeof value["sessionId"] !== "string" ||
    typeof value["sessionPath"] !== "string" ||
    typeof value["createdAt"] !== "string" ||
    typeof value["sourceType"] !== "string" ||
    typeof value["summaryText"] !== "string"
  ) {
    return null;
  }

  const rawScore = value["_distance"] ?? value["_score"] ?? value["score"] ?? 0;
  const normalizedScore = typeof rawScore === "number"
    ? rawScore
    : Number(rawScore) || 0;

  return {
    sessionId: value["sessionId"],
    sessionPath: value["sessionPath"],
    createdAt: value["createdAt"],
    sourceType: value["sourceType"] === "handoff" ? "handoff" : "task_summary",
    summaryText: value["summaryText"],
    score: Number(normalizedScore.toFixed(4)),
  };
}

function isRecallMemoryRecord(value: unknown): value is RecallMemoryRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row["id"] === "string" &&
    typeof row["clientId"] === "string" &&
    typeof row["sessionId"] === "string" &&
    typeof row["sessionPath"] === "string" &&
    typeof row["createdAt"] === "string" &&
    typeof row["sourceType"] === "string" &&
    typeof row["summaryText"] === "string" &&
    Array.isArray(row["embedding"])
  );
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeLowerBound(value?: string): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  return trimmed;
}

function normalizeUpperBound(value?: string): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T23:59:59.999Z`;
  }
  return trimmed;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

async function importOptionalModules(...specifiers: string[]): Promise<unknown | null> {
  const importer = new Function("s", "return import(s);") as (name: string) => Promise<unknown>;
  for (const specifier of specifiers) {
    try {
      return await importer(specifier);
    } catch {
      continue;
    }
  }
  return null;
}
