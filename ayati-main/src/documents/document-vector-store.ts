import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  DocumentChunkVectorMatch,
  DocumentChunkVectorRecord,
  DocumentVectorSearchInput,
  DocumentVectorStore,
} from "./document-vector-types.js";

export interface LanceDocumentVectorStoreOptions {
  dataDir?: string;
  tableName?: string;
  fallbackFileName?: string;
}

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data", "documents", "vector");

export class LanceDocumentVectorStore implements DocumentVectorStore {
  private readonly dataDir: string;
  private readonly tableName: string;
  private readonly fallbackFilePath: string;
  private lanceDisabled = false;

  constructor(options?: LanceDocumentVectorStoreOptions) {
    this.dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.tableName = options?.tableName ?? "document_chunks";
    this.fallbackFilePath = resolve(this.dataDir, options?.fallbackFileName ?? "document-chunks.json");
  }

  async upsertDocumentChunks(records: DocumentChunkVectorRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const usedLance = await this.tryUpsertWithLance(records);
    if (usedLance) {
      return;
    }

    const existing = this.readFallbackRecords();
    const next = existing.filter((candidate) => !shouldReplaceRecord(candidate, records));
    next.push(...records);
    this.writeFallbackRecords(next);
  }

  async search(input: DocumentVectorSearchInput): Promise<DocumentChunkVectorMatch[]> {
    const viaLance = await this.trySearchWithLance(input);
    if (viaLance) {
      return viaLance;
    }

    return this.searchFallback(input);
  }

  private async tryUpsertWithLance(records: DocumentChunkVectorRecord[]): Promise<boolean> {
    const table = await this.getLanceTable() as {
      delete?: (filter: string) => Promise<void>;
      add?: (rows: unknown[]) => Promise<void>;
    } | null;
    if (!table) {
      return false;
    }

    try {
      const keys = buildReplacementKeys(records);
      if (typeof table.delete === "function") {
        for (const key of keys) {
          await table.delete(
            `documentId = '${escapeSql(key.documentId)}' AND embeddingModel = '${escapeSql(key.embeddingModel)}'`,
          );
        }
      }
      if (typeof table.add === "function") {
        await table.add(records);
        return true;
      }
    } catch {
      this.lanceDisabled = true;
    }

    return false;
  }

  private async trySearchWithLance(input: DocumentVectorSearchInput): Promise<DocumentChunkVectorMatch[] | null> {
    const table = await this.getLanceTable() as {
      search?: (vector: number[]) => unknown;
    } | null;
    if (!table || typeof table.search !== "function") {
      return null;
    }

    try {
      let query = table.search(input.vector) as {
        where?: (clause: string, options?: Record<string, unknown>) => Promise<unknown> | unknown;
        limit?: (value: number) => Promise<unknown> | unknown;
        toArray?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
      const filterClause = buildSearchFilterClause(input);
      if (typeof query.where === "function") {
        query = await query.where(filterClause, { prefilter: true }) as typeof query;
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
        .filter((row): row is DocumentChunkVectorMatch => row !== null)
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

  private searchFallback(input: DocumentVectorSearchInput): DocumentChunkVectorMatch[] {
    const documentIds = new Set(input.documentIds);
    return this.readFallbackRecords()
      .filter((record) => documentIds.has(record.documentId))
      .filter((record) => record.embeddingModel === input.embeddingModel)
      .map((record) => ({
        record,
        score: cosineSimilarity(input.vector, record.embedding),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.record.sourceId.localeCompare(b.record.sourceId);
      })
      .slice(0, input.limit)
      .map(({ record, score }) => ({
        id: record.id,
        documentId: record.documentId,
        sourceId: record.sourceId,
        documentName: record.documentName,
        documentPath: record.documentPath,
        location: record.location,
        text: record.text,
        tokens: record.tokens,
        score: Number(score.toFixed(4)),
      }));
  }

  private readFallbackRecords(): DocumentChunkVectorRecord[] {
    if (!existsSync(this.fallbackFilePath)) {
      return [];
    }

    try {
      const raw = readFileSync(this.fallbackFilePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isDocumentChunkVectorRecord);
    } catch {
      return [];
    }
  }

  private writeFallbackRecords(records: DocumentChunkVectorRecord[]): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.fallbackFilePath, JSON.stringify(records, null, 2), "utf8");
  }
}

function buildReplacementKeys(records: DocumentChunkVectorRecord[]): Array<{ documentId: string; embeddingModel: string }> {
  return [...new Map(records.map((record) => [`${record.documentId}:${record.embeddingModel}`, {
    documentId: record.documentId,
    embeddingModel: record.embeddingModel,
  }])).values()];
}

function shouldReplaceRecord(candidate: DocumentChunkVectorRecord, incomingRecords: DocumentChunkVectorRecord[]): boolean {
  return incomingRecords.some((record) => (
    record.documentId === candidate.documentId
    && record.embeddingModel === candidate.embeddingModel
  ));
}

function buildSearchFilterClause(input: DocumentVectorSearchInput): string {
  const documentFilter = input.documentIds.length > 0
    ? `documentId IN (${input.documentIds.map((id) => `'${escapeSql(id)}'`).join(", ")})`
    : "1 = 1";
  return `${documentFilter} AND embeddingModel = '${escapeSql(input.embeddingModel)}'`;
}

function normalizeMatchRow(row: unknown): DocumentChunkVectorMatch | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const value = row as Record<string, unknown>;
  if (
    typeof value["id"] !== "string"
    || typeof value["documentId"] !== "string"
    || typeof value["sourceId"] !== "string"
    || typeof value["documentName"] !== "string"
    || typeof value["documentPath"] !== "string"
    || typeof value["location"] !== "string"
    || typeof value["text"] !== "string"
  ) {
    return null;
  }

  const rawScore = value["_distance"] ?? value["_score"] ?? value["score"] ?? 0;
  return {
    id: value["id"],
    documentId: value["documentId"],
    sourceId: value["sourceId"],
    documentName: value["documentName"],
    documentPath: value["documentPath"],
    location: value["location"],
    text: value["text"],
    tokens: typeof value["tokens"] === "number" ? value["tokens"] : Number(value["tokens"]) || 0,
    score: Number((typeof rawScore === "number" ? rawScore : Number(rawScore) || 0).toFixed(4)),
  };
}

function isDocumentChunkVectorRecord(value: unknown): value is DocumentChunkVectorRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row["id"] === "string"
    && typeof row["documentId"] === "string"
    && typeof row["checksum"] === "string"
    && typeof row["sourceId"] === "string"
    && typeof row["documentName"] === "string"
    && typeof row["documentPath"] === "string"
    && typeof row["location"] === "string"
    && typeof row["text"] === "string"
    && Array.isArray(row["embedding"])
    && typeof row["embeddingModel"] === "string"
    && typeof row["indexedAt"] === "string"
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
