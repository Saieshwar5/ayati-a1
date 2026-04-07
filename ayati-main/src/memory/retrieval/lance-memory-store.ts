import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  RecallCandidate,
  RecallMemoryRecord,
  RecallSearchInput,
  RecallSourceType,
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

  async search(input: RecallSearchInput): Promise<RecallCandidate[]> {
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

  private async trySearchWithLance(input: RecallSearchInput): Promise<RecallCandidate[] | null> {
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

      if (typeof query.where === "function") {
        query = await query.where(buildFilterClause(input), { prefilter: true }) as typeof query;
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
        .map((row) => normalizeCandidateRow(row))
        .filter((row): row is RecallCandidate => row !== null)
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

  private searchFallback(input: RecallSearchInput): RecallCandidate[] {
    const lower = normalizeLowerBound(input.dateFrom);
    const upper = normalizeUpperBound(input.dateTo);
    const sourceTypes = input.sourceTypes?.length ? new Set(input.sourceTypes) : null;

    return this.readFallbackRecords()
      .filter((record) => record.clientId === input.clientId)
      .filter((record) => (lower ? record.createdAt >= lower : true))
      .filter((record) => (upper ? record.createdAt <= upper : true))
      .filter((record) => (sourceTypes ? sourceTypes.has(record.sourceType) : true))
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
      .slice(0, input.limit)
      .map(({ record, score }) => toCandidate(record, score));
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

function buildFilterClause(input: RecallSearchInput): string {
  const whereParts = [`clientId = '${escapeSql(input.clientId)}'`];
  const lower = normalizeLowerBound(input.dateFrom);
  const upper = normalizeUpperBound(input.dateTo);
  if (lower) {
    whereParts.push(`createdAt >= '${escapeSql(lower)}'`);
  }
  if (upper) {
    whereParts.push(`createdAt <= '${escapeSql(upper)}'`);
  }
  if (input.sourceTypes && input.sourceTypes.length > 0) {
    whereParts.push(`sourceType IN (${input.sourceTypes.map((value) => `'${escapeSql(value)}'`).join(", ")})`);
  }
  return whereParts.join(" AND ");
}

function normalizeCandidateRow(row: unknown): RecallCandidate | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const value = row as Record<string, unknown>;
  if (
    typeof value["id"] !== "string"
    || typeof value["nodeType"] !== "string"
    || typeof value["sourceType"] !== "string"
    || typeof value["sessionId"] !== "string"
    || typeof value["sessionPath"] !== "string"
    || typeof value["sessionFilePath"] !== "string"
    || typeof value["createdAt"] !== "string"
    || typeof value["summaryText"] !== "string"
    || typeof value["retrievalText"] !== "string"
  ) {
    return null;
  }

  const distanceValue = value["_distance"];
  const rawScore = distanceValue ?? value["_score"] ?? value["score"] ?? 0;
  const normalizedScore = typeof distanceValue === "number"
    ? 1 / (1 + Math.max(distanceValue, 0))
    : (typeof rawScore === "number" ? rawScore : Number(rawScore) || 0);

  return {
    nodeId: value["id"],
    nodeType: value["nodeType"] === "handoff" ? "handoff" : "run",
    sourceType: normalizeSourceType(value["sourceType"]),
    sessionId: value["sessionId"],
    sessionPath: value["sessionPath"],
    sessionFilePath: value["sessionFilePath"],
    runId: typeof value["runId"] === "string" ? value["runId"] : undefined,
    runPath: typeof value["runPath"] === "string" ? value["runPath"] : undefined,
    runStatePath: typeof value["runStatePath"] === "string" ? value["runStatePath"] : undefined,
    createdAt: value["createdAt"],
    status: normalizeStatus(value["status"]),
    summaryText: value["summaryText"],
    retrievalText: value["retrievalText"],
    userMessage: typeof value["userMessage"] === "string" ? value["userMessage"] : undefined,
    assistantResponse: typeof value["assistantResponse"] === "string" ? value["assistantResponse"] : undefined,
    metadataJson: typeof value["metadataJson"] === "string" ? value["metadataJson"] : undefined,
    score: Number(normalizedScore.toFixed(4)),
  };
}

function toCandidate(record: RecallMemoryRecord, score: number): RecallCandidate {
  return {
    nodeId: record.id,
    nodeType: record.nodeType,
    sourceType: record.sourceType,
    sessionId: record.sessionId,
    sessionPath: record.sessionPath,
    sessionFilePath: record.sessionFilePath,
    runId: record.runId,
    runPath: record.runPath,
    runStatePath: record.runStatePath,
    createdAt: record.createdAt,
    status: record.status,
    summaryText: record.summaryText,
    retrievalText: record.retrievalText,
    userMessage: record.userMessage,
    assistantResponse: record.assistantResponse,
    metadataJson: record.metadataJson,
    score: Number(score.toFixed(4)),
  };
}

function isRecallMemoryRecord(value: unknown): value is RecallMemoryRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row["id"] === "string"
    && typeof row["clientId"] === "string"
    && typeof row["nodeType"] === "string"
    && typeof row["sourceType"] === "string"
    && typeof row["sessionId"] === "string"
    && typeof row["sessionPath"] === "string"
    && typeof row["sessionFilePath"] === "string"
    && typeof row["createdAt"] === "string"
    && typeof row["summaryText"] === "string"
    && typeof row["retrievalText"] === "string"
    && typeof row["embeddingModel"] === "string"
    && Array.isArray(row["embedding"])
  );
}

function normalizeSourceType(value: unknown): RecallSourceType {
  return value === "handoff" ? "handoff" : "run";
}

function normalizeStatus(value: unknown): RecallCandidate["status"] {
  if (value === "completed" || value === "failed" || value === "stuck") {
    return value;
  }
  return undefined;
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
  for (const specifier of specifiers) {
    try {
      return await import(specifier);
    } catch {
      continue;
    }
  }
  return null;
}
