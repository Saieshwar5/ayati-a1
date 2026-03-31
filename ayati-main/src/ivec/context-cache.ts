import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devLog } from "../shared/index.js";
import type { ContextSearchDirective, ScoutResult } from "./types.js";

export type ContextSearchScope = ContextSearchDirective["scope"];
export type ContextCacheStatus =
  | "success"
  | "sufficient"
  | "partial"
  | "empty"
  | "unavailable";

export interface ContextCacheEntry {
  id: string;
  scope: ContextSearchScope;
  status: ContextCacheStatus;
  query: string;
  context: string;
  sources: string[];
  confidence: number;
}

interface ContextCacheFile {
  version: 3;
  entries: ContextCacheEntry[];
}

interface LegacyContextCacheEntry {
  scope?: ContextSearchScope;
  targets?: string[];
  context?: string;
  sources?: string[];
  confidence?: number;
  status?: "success" | "empty" | "unavailable";
  documentState?: {
    status?: "sufficient" | "partial" | "empty" | "unavailable";
  };
}

interface LegacyContextCacheFile {
  version?: number;
  entries?: LegacyContextCacheEntry[];
}

export interface ContextCacheMetadataEntry {
  id: string;
  scope: ContextSearchScope;
  status: ContextCacheStatus;
  query: string;
  confidence: number;
}

export interface ContextCacheStoreInput {
  scope: ContextSearchScope;
  query: string;
  result: ScoutResult;
}

const CACHE_FILE_NAME = "context-cache.json";
const CACHE_VERSION = 3;
const MAX_CACHE_ENTRIES = 20;

export function listContextCacheMetadata(
  runPath: string,
  scope: ContextSearchScope,
): ContextCacheMetadataEntry[] {
  return readCache(runPath).entries
    .filter((entry) => scopeSatisfies(entry.scope, scope))
    .map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      status: entry.status,
      query: entry.query,
      confidence: entry.confidence,
    }));
}

export function getContextCacheEntriesByIds(
  runPath: string,
  ids: string[],
): ContextCacheEntry[] {
  if (ids.length === 0) {
    return [];
  }

  const cache = readCache(runPath);
  const order = new Map(ids.map((id, index) => [id, index]));
  return cache.entries
    .filter((entry) => order.has(entry.id))
    .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export function storeContextCache(runPath: string, input: ContextCacheStoreInput): ContextCacheEntry {
  const cache = readCache(runPath);
  const nextSources = uniqueStrings(input.result.sources.map(normalizePath));
  const existing = cache.entries.find((entry) =>
    entry.scope === input.scope
    && normalizeQuery(entry.query) === normalizeQuery(input.query)
    && sameSources(entry.sources, nextSources),
  );

  const nextEntry: ContextCacheEntry = {
    id: existing?.id ?? createContextCacheId(cache.entries),
    scope: input.scope,
    status: deriveStatus(input.result),
    query: input.query.trim(),
    context: input.result.context,
    sources: nextSources,
    confidence: clampConfidence(input.result.confidence),
  };

  const nextEntries = cache.entries.filter((entry) => entry.id !== nextEntry.id);
  nextEntries.push(nextEntry);
  const pruned = pruneEntries(nextEntries);
  writeCache(runPath, pruned);
  devLog(
    `[context-cache] store scope=${input.scope} status=${nextEntry.status} query="${formatQueryForLog(input.query)}" id=${nextEntry.id}`,
  );
  return nextEntry;
}

export function getContextCachePath(runPath: string): string {
  return join(runPath, CACHE_FILE_NAME);
}

function readCache(runPath: string): ContextCacheFile {
  const cachePath = getContextCachePath(runPath);
  if (!existsSync(cachePath)) {
    return { version: CACHE_VERSION, entries: [] };
  }

  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ContextCacheFile> & LegacyContextCacheFile;
    if (parsed.version === CACHE_VERSION) {
      const entries = Array.isArray(parsed.entries)
        ? (parsed.entries as unknown[]).map(normalizeCacheEntry).filter((entry): entry is ContextCacheEntry => entry !== null)
        : [];
      return { version: CACHE_VERSION, entries };
    }

    if (parsed.version === 2) {
      const migrated = Array.isArray(parsed.entries)
        ? (parsed.entries as LegacyContextCacheEntry[]).map((entry, index) => migrateLegacyEntry(entry, index)).filter((entry): entry is ContextCacheEntry => entry !== null)
        : [];
      return { version: CACHE_VERSION, entries: migrated };
    }

    return { version: CACHE_VERSION, entries: [] };
  } catch {
    return { version: CACHE_VERSION, entries: [] };
  }
}

function writeCache(runPath: string, entries: ContextCacheEntry[]): void {
  const cachePath = getContextCachePath(runPath);
  const payload: ContextCacheFile = { version: CACHE_VERSION, entries };
  writeFileSync(cachePath, JSON.stringify(payload, null, 2), "utf-8");
}

function normalizeCacheEntry(value: unknown): ContextCacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<ContextCacheEntry>;
  if (
    typeof entry.id !== "string"
    || typeof entry.scope !== "string"
    || typeof entry.status !== "string"
    || typeof entry.query !== "string"
    || typeof entry.context !== "string"
    || !Array.isArray(entry.sources)
    || typeof entry.confidence !== "number"
  ) {
    return null;
  }

  if (!isValidStatus(entry.status)) {
    return null;
  }

  return {
    id: entry.id,
    scope: entry.scope,
    status: entry.status,
    query: entry.query,
    context: entry.context,
    sources: entry.sources.map(String).map(normalizePath),
    confidence: clampConfidence(entry.confidence),
  };
}

function migrateLegacyEntry(value: LegacyContextCacheEntry, index: number): ContextCacheEntry | null {
  if (!value || typeof value.scope !== "string" || typeof value.context !== "string") {
    return null;
  }

  const legacySources = Array.isArray(value.sources) ? value.sources.map(String).map(normalizePath) : [];
  const status = normalizeLegacyStatus(value);
  const legacyQuery = Array.isArray(value.targets) && value.targets.length > 0
    ? value.targets.join(", ")
    : legacySources.length > 0
      ? legacySources.join(", ")
      : value.context.trim().slice(0, 120);

  return {
    id: `cc_legacy_${index + 1}`,
    scope: value.scope,
    status,
    query: legacyQuery,
    context: value.context,
    sources: legacySources,
    confidence: clampConfidence(Number(value.confidence) || 0),
  };
}

function createContextCacheId(entries: ContextCacheEntry[]): string {
  const nextNumber = entries.reduce((maxId, entry) => {
    const match = entry.id.match(/^cc_(\d+)$/);
    const parsed = match?.[1] ? Number(match[1]) : 0;
    return Math.max(maxId, Number.isFinite(parsed) ? parsed : 0);
  }, 0) + 1;
  return `cc_${String(nextNumber).padStart(3, "0")}`;
}

function normalizeLegacyStatus(value: LegacyContextCacheEntry): ContextCacheStatus {
  const documentStatus = value.documentState?.status;
  if (documentStatus && isValidStatus(documentStatus)) {
    return documentStatus;
  }

  if (value.status && isValidStatus(value.status)) {
    return value.status;
  }

  return value.context?.trim() ? "success" : "empty";
}

function deriveStatus(result: ScoutResult): ContextCacheStatus {
  const documentStatus = result.documentState?.status;
  if (documentStatus) {
    return documentStatus;
  }

  if (result.scoutState?.status === "empty" || result.scoutState?.status === "max_turns_exhausted") {
    return "empty";
  }

  return result.context.trim().length > 0 ? "success" : "empty";
}

function pruneEntries(entries: ContextCacheEntry[]): ContextCacheEntry[] {
  return entries.slice(-MAX_CACHE_ENTRIES);
}

function scopeSatisfies(entryScope: ContextSearchScope, requestedScope: ContextSearchScope): boolean {
  return entryScope === requestedScope || (entryScope === "both" && requestedScope !== "both");
}

function isValidStatus(value: string): value is ContextCacheStatus {
  return value === "success"
    || value === "sufficient"
    || value === "partial"
    || value === "empty"
    || value === "unavailable";
}

function sameSources(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function formatQueryForLog(query: string): string {
  const compact = query.replace(/\s+/g, " ").trim();
  if (compact.length <= 140) return compact;
  return `${compact.slice(0, 140)}...`;
}
