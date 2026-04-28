import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  EpisodicMemoryEpisodeType,
  EpisodicMemoryRecord,
  EpisodicRecallMatch,
  EpisodicVectorSearchInput,
  EpisodicVectorStore,
} from "./types.js";

export interface LanceEpisodicVectorStoreOptions {
  dataDir?: string;
  tableName?: string;
}

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data", "memory", "episodic-vectors");

export class LanceEpisodicVectorStore implements EpisodicVectorStore {
  private readonly dataDir: string;
  private readonly tableName: string;

  constructor(options?: LanceEpisodicVectorStoreOptions) {
    this.dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.tableName = options?.tableName ?? "episodic_memory";
  }

  async upsertEpisodes(records: EpisodicMemoryRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const table = await this.openTableForWrite(records);
    if (!table) {
      return;
    }

    const writable = table as {
      delete?: (filter: string) => Promise<void>;
      add?: (rows: unknown[]) => Promise<void>;
    };
    if (typeof writable.delete === "function") {
      for (const record of records) {
        await writable.delete(
          `episodeId = '${escapeSql(record.episodeId)}' AND embeddingModel = '${escapeSql(record.embeddingModel)}'`,
        );
      }
    }
    if (typeof writable.add !== "function") {
      throw new Error("LanceDB table does not support add().");
    }
    await writable.add(records);
  }

  async search(input: EpisodicVectorSearchInput): Promise<EpisodicRecallMatch[]> {
    const table = await this.openTableForRead();
    if (!table) {
      return [];
    }

    const searchable = table as {
      search?: (vector?: number[]) => unknown;
      query?: () => unknown;
    };
    let query = input.vector && input.vector.length > 0 && typeof searchable.search === "function"
      ? searchable.search(input.vector)
      : (typeof searchable.query === "function" ? searchable.query() : null);
    if (!query) {
      return [];
    }

    query = await maybeCall(query, "distanceType", "cosine");
    query = await maybeCall(query, "distance_type", "cosine");
    query = await maybeCall(query, "where", buildFilterClause(input), { prefilter: true });
    query = await maybeCall(query, "limit", input.limit);

    const rows = await collectRows(query);
    return rows
      .map((row) => normalizeMatchRow(row))
      .filter((row): row is EpisodicRecallMatch => row !== null)
      .slice(0, input.limit);
  }

  private async openTableForRead(): Promise<unknown | null> {
    const db = await this.connect();
    if (!db || typeof (db as { openTable?: unknown }).openTable !== "function") {
      return null;
    }

    try {
      return await (db as { openTable: (name: string) => Promise<unknown> }).openTable(this.tableName);
    } catch {
      return null;
    }
  }

  private async openTableForWrite(initialRecords: EpisodicMemoryRecord[]): Promise<unknown | null> {
    const db = await this.connect();
    if (!db || typeof (db as { openTable?: unknown }).openTable !== "function") {
      return null;
    }

    try {
      return await (db as { openTable: (name: string) => Promise<unknown> }).openTable(this.tableName);
    } catch {
      if (typeof (db as { createTable?: unknown }).createTable !== "function") {
        return null;
      }
      return await (db as { createTable: (name: string, rows: unknown[]) => Promise<unknown> })
        .createTable(this.tableName, initialRecords);
    }
  }

  private async connect(): Promise<unknown> {
    const module = await import("@lancedb/lancedb");
    const connect = (module as { connect?: unknown; default?: { connect?: unknown } }).connect
      ?? (module as { default?: { connect?: unknown } }).default?.connect;
    if (typeof connect !== "function") {
      throw new Error("@lancedb/lancedb did not expose connect().");
    }

    mkdirSync(this.dataDir, { recursive: true });
    return await (connect as (path: string) => Promise<unknown>)(this.dataDir);
  }
}

async function maybeCall(target: unknown, methodName: string, ...args: unknown[]): Promise<unknown> {
  if (!target || typeof target !== "object") {
    return target;
  }
  const fn = (target as Record<string, unknown>)[methodName];
  if (typeof fn !== "function") {
    return target;
  }
  return await (fn as (...callArgs: unknown[]) => unknown).call(target, ...args);
}

async function collectRows(query: unknown): Promise<unknown[]> {
  if (!query || typeof query !== "object") {
    return [];
  }
  const value = query as {
    toArray?: () => Promise<unknown>;
    execute?: () => Promise<unknown>;
    to_list?: () => Promise<unknown>;
  };
  const rows = typeof value.toArray === "function"
    ? await value.toArray()
    : (typeof value.execute === "function"
        ? await value.execute()
        : (typeof value.to_list === "function" ? await value.to_list() : []));
  return Array.isArray(rows) ? rows : [];
}

function buildFilterClause(input: EpisodicVectorSearchInput): string {
  const filters = [
    `clientId = '${escapeSql(input.clientId)}'`,
    `embeddingModel = '${escapeSql(input.embeddingModel)}'`,
  ];
  const lower = normalizeLowerBound(input.dateFrom);
  const upper = normalizeUpperBound(input.dateTo);
  if (lower) {
    filters.push(`createdAt >= '${escapeSql(lower)}'`);
  }
  if (upper) {
    filters.push(`createdAt <= '${escapeSql(upper)}'`);
  }
  if (input.episodeTypes && input.episodeTypes.length > 0) {
    filters.push(`episodeType IN (${input.episodeTypes.map((value) => `'${escapeSql(value)}'`).join(", ")})`);
  }
  return filters.join(" AND ");
}

function normalizeMatchRow(row: unknown): EpisodicRecallMatch | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const value = row as Record<string, unknown>;
  if (
    typeof value["episodeId"] !== "string"
    || !isEpisodeType(value["episodeType"])
    || typeof value["createdAt"] !== "string"
    || typeof value["summary"] !== "string"
    || typeof value["sessionId"] !== "string"
    || typeof value["sessionPath"] !== "string"
    || typeof value["sessionFilePath"] !== "string"
    || typeof value["contentHash"] !== "string"
  ) {
    return null;
  }

  const rawDistance = value["_distance"];
  const rawScore = value["_score"] ?? value["score"];
  const score = typeof rawScore === "number"
    ? rawScore
    : (typeof rawDistance === "number" ? 1 / (1 + Math.max(0, rawDistance)) : 0);

  return {
    episodeId: value["episodeId"],
    episodeType: value["episodeType"],
    createdAt: value["createdAt"],
    summary: value["summary"],
    matchedText: typeof value["sourceText"] === "string" ? value["sourceText"] : value["summary"],
    score: Number(score.toFixed(4)),
    sessionId: value["sessionId"],
    sessionPath: value["sessionPath"],
    sessionFilePath: value["sessionFilePath"],
    ...(typeof value["runId"] === "string" ? { runId: value["runId"] } : {}),
    eventStartIndex: typeof value["eventStartIndex"] === "number" ? value["eventStartIndex"] : Number(value["eventStartIndex"]) || 0,
    eventEndIndex: typeof value["eventEndIndex"] === "number" ? value["eventEndIndex"] : Number(value["eventEndIndex"]) || 0,
    contentHash: value["contentHash"],
  };
}

function isEpisodeType(value: unknown): value is EpisodicMemoryEpisodeType {
  return value === "conversation_exchange" || value === "task_outcome" || value === "session_summary";
}

function normalizeLowerBound(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  return trimmed;
}

function normalizeUpperBound(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T23:59:59.999Z`;
  }
  return trimmed;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
