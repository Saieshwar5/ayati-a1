import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { devLog } from "../shared/index.js";
import type { ScoutKnownLocations } from "./context-scout.js";
import type { ContextSearchDirective, ScoutResult, DocumentScoutState } from "./types.js";

export type ContextSearchScope = ContextSearchDirective["scope"];

export interface ContextCacheEntry {
  scope: ContextSearchScope;
  targets: string[];
  context: string;
  sources: string[];
  confidence: number;
  status: "success" | "empty" | "unavailable";
  documentState?: DocumentScoutState;
  createdAtIteration: number;
  lastUsedIteration: number;
}

interface ContextCacheFile {
  version: 2;
  entries: ContextCacheEntry[];
}

export interface ContextCacheLookupInput {
  scope: ContextSearchScope;
  query: string;
  knownLocations: ScoutKnownLocations;
  iteration: number;
  documentPaths?: string[];
}

export interface ContextCacheStoreInput extends ContextCacheLookupInput {
  result: ScoutResult;
}

const CACHE_FILE_NAME = "context-cache.json";
const CACHE_VERSION = 2;
const MAX_CACHE_ENTRIES = 20;
const MIN_SUCCESS_CONFIDENCE = 0.6;
const SKILL_QUERY_STOPWORDS = new Set([
  "command",
  "commands",
  "context",
  "external",
  "full",
  "installed",
  "latest",
  "load",
  "need",
  "query",
  "reference",
  "scope",
  "search",
  "skill",
  "skills",
  "use",
]);

export function lookupContextCache(runPath: string, input: ContextCacheLookupInput): ContextCacheEntry | null {
  const requestedTargets = normalizeTargetsFromQuery(input.scope, input.query, input.knownLocations, input.documentPaths);
  if (requestedTargets.length === 0) {
    devLog(`[context-cache] miss scope=${input.scope} reason=no-normalized-targets query="${formatQueryForLog(input.query)}"`);
    return null;
  }

  const cache = readCache(runPath);
  const candidates = cache.entries
    .filter((entry) => scopeSatisfies(entry.scope, input.scope))
    .filter((entry) => coversTargets(entry.targets, requestedTargets))
    .filter((entry) =>
      entry.status === "empty"
      || entry.status === "unavailable"
      || entry.confidence >= MIN_SUCCESS_CONFIDENCE
    )
    .sort((a, b) => {
      if (a.targets.length !== b.targets.length) return a.targets.length - b.targets.length;
      return b.lastUsedIteration - a.lastUsedIteration;
    });

  const hit = candidates[0];
  if (!hit) {
    devLog(`[context-cache] miss scope=${input.scope} targets=${requestedTargets.join(",")} query="${formatQueryForLog(input.query)}"`);
    return null;
  }

  hit.lastUsedIteration = input.iteration;
  writeCache(runPath, cache.entries);
  devLog(`[context-cache] hit scope=${input.scope} targets=${hit.targets.join(",")} status=${hit.status} query="${formatQueryForLog(input.query)}"`);
  return hit;
}

export function storeContextCache(runPath: string, input: ContextCacheStoreInput): ContextCacheEntry | null {
  const targets = normalizeTargetsForStorage(
    input.scope,
    input.query,
    input.result.sources,
    input.knownLocations,
    input.documentPaths,
  );
  if (targets.length === 0) {
    devLog(`[context-cache] skip-store scope=${input.scope} reason=no-normalized-targets`);
    return null;
  }

  const cache = readCache(runPath);
  const existing = cache.entries.find((entry) => entry.scope === input.scope && sameTargets(entry.targets, targets));
  const resultContext = input.result.context;
  const status: ContextCacheEntry["status"] = input.result.documentState?.status === "unavailable"
    ? "unavailable"
    : input.result.documentState?.status === "empty"
    ? "empty"
    : resultContext.trim().length > 0
    ? "success"
    : "empty";
  const nextEntry: ContextCacheEntry = {
    scope: input.scope,
    targets,
    context: resultContext,
    sources: uniqueStrings(input.result.sources.map(normalizePath)),
    confidence: clampConfidence(input.result.confidence),
    status,
    documentState: input.result.documentState,
    createdAtIteration: existing?.createdAtIteration ?? input.iteration,
    lastUsedIteration: input.iteration,
  };

  const nextEntries = cache.entries.filter((entry) => !(entry.scope === input.scope && sameTargets(entry.targets, targets)));
  nextEntries.push(nextEntry);
  const pruned = pruneEntries(nextEntries);
  writeCache(runPath, pruned);
  devLog(`[context-cache] store scope=${input.scope} targets=${targets.join(",")} status=${status} query="${formatQueryForLog(input.query)}"`);
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
    const parsed = JSON.parse(raw) as Partial<ContextCacheFile>;
    if (parsed.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: [] };
    }
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.map(normalizeCacheEntry).filter((entry): entry is ContextCacheEntry => entry !== null)
      : [];
    return { version: CACHE_VERSION, entries };
  } catch {
    return { version: CACHE_VERSION, entries: [] };
  }
}

function writeCache(runPath: string, entries: ContextCacheEntry[]): void {
  const cachePath = getContextCachePath(runPath);
  const payload: ContextCacheFile = { version: CACHE_VERSION, entries };
  writeFileSync(cachePath, JSON.stringify(payload, null, 2), "utf-8");
}

function isCacheEntry(value: unknown): value is ContextCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ContextCacheEntry>;
  return typeof entry.scope === "string"
    && Array.isArray(entry.targets)
    && Array.isArray(entry.sources)
    && typeof entry.context === "string"
    && typeof entry.confidence === "number"
    && (entry.status === "success" || entry.status === "empty" || entry.status === "unavailable")
    && typeof entry.createdAtIteration === "number"
    && typeof entry.lastUsedIteration === "number";
}

function normalizeCacheEntry(value: unknown): ContextCacheEntry | null {
  if (!isCacheEntry(value)) return null;
  const entry = value as Partial<ContextCacheEntry>;
  return {
    scope: entry.scope!,
    targets: [...entry.targets!],
    context: entry.context!,
    sources: [...entry.sources!],
    confidence: entry.confidence!,
    status: entry.status!,
    documentState: entry.documentState,
    createdAtIteration: entry.createdAtIteration!,
    lastUsedIteration: entry.lastUsedIteration!,
  };
}

function normalizeTargetsForStorage(
  scope: ContextSearchScope,
  query: string,
  sources: string[],
  knownLocations: ScoutKnownLocations,
  documentPaths?: string[],
): string[] {
  return uniqueStrings([
    ...normalizeTargetsFromQuery(scope, query, knownLocations, documentPaths),
    ...normalizeTargetsFromSources(scope, sources, knownLocations, documentPaths),
  ]).sort();
}

function normalizeTargetsFromQuery(
  scope: ContextSearchScope,
  query: string,
  knownLocations: ScoutKnownLocations,
  documentPaths?: string[],
): string[] {
  const targets: string[] = [];

  if (scope === "skills" || scope === "both") {
    targets.push(...extractSkillTargetsFromQuery(query, knownLocations.skillsDir));
  }
  if (scope === "run_artifacts" || scope === "both") {
    targets.push(...extractRunArtifactTargetsFromQuery(query));
  }
  if (scope === "project_context" || scope === "both") {
    targets.push(...extractProjectContextTargetsFromQuery(query));
  }
  if (scope === "session" || scope === "both") {
    targets.push(...extractSessionTargetsFromQuery(query, knownLocations));
  }
  if (scope === "documents") {
    targets.push(...extractDocumentTargetsFromPaths(documentPaths, knownLocations));
    targets.push(`documents:query:${hashQuery(query)}`);
  }

  return uniqueStrings(targets).sort();
}

function normalizeTargetsFromSources(
  scope: ContextSearchScope,
  sources: string[],
  knownLocations: ScoutKnownLocations,
  documentPaths?: string[],
): string[] {
  const targets: string[] = [];

  for (const source of sources) {
    const normalizedSource = normalizePath(source);
    if (scope === "skills" || scope === "both") {
      targets.push(...extractSkillTargetsFromSource(normalizedSource));
    }
    if (scope === "run_artifacts" || scope === "both") {
      targets.push(...extractRunArtifactTargetsFromSource(normalizedSource, knownLocations.runPath));
    }
    if (scope === "project_context" || scope === "both") {
      targets.push(...extractProjectContextTargetsFromSource(normalizedSource, knownLocations.contextDir));
    }
    if (scope === "session" || scope === "both") {
      targets.push(...extractSessionTargetsFromSource(normalizedSource, knownLocations));
    }
    if (scope === "documents") {
      targets.push(...extractDocumentTargetsFromSource(normalizedSource, knownLocations));
    }
  }

  if (scope === "documents") {
    targets.push(...extractDocumentTargetsFromPaths(documentPaths, knownLocations));
  }

  return uniqueStrings(targets).sort();
}

function extractDocumentTargetsFromPaths(documentPaths: string[] | undefined, knownLocations: ScoutKnownLocations): string[] {
  const attachedDocuments = knownLocations.attachedDocuments ?? [];
  if (attachedDocuments.length === 0) return [];

  const requested = documentPaths && documentPaths.length > 0
    ? new Set(documentPaths.map(normalizePath))
    : null;

  return attachedDocuments
    .filter((document) => {
      if (!requested) return true;
      return requested.has(normalizePath(document.originalPath)) || requested.has(normalizePath(document.storedPath));
    })
    .map((document) => `documents:doc:${document.documentId}`);
}

function extractDocumentTargetsFromSource(source: string, knownLocations: ScoutKnownLocations): string[] {
  const attachedDocuments = knownLocations.attachedDocuments ?? [];
  for (const document of attachedDocuments) {
    if (source === normalizePath(document.originalPath) || source === normalizePath(document.storedPath)) {
      return [`documents:doc:${document.documentId}`];
    }
  }
  return [];
}

function extractSkillTargetsFromQuery(query: string, skillsDir?: string): string[] {
  if (!skillsDir || !existsSync(skillsDir)) return [];
  const skillIds = readdirSync(skillsDir)
    .filter((entry) => {
      try {
        return statSync(join(skillsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });

  const queryLower = query.toLowerCase();
  const queryTokens = new Set(tokenize(query).filter((token) => token.length >= 4 && !SKILL_QUERY_STOPWORDS.has(token)));
  const targets: string[] = [];

  for (const skillId of skillIds) {
    const skillLower = skillId.toLowerCase();
    const exactMatch = queryLower.includes(skillLower);
    const tokenMatch = tokenize(skillLower)
      .filter((token) => token.length >= 4 && !SKILL_QUERY_STOPWORDS.has(token))
      .some((token) => queryTokens.has(token));
    if (exactMatch || tokenMatch) {
      targets.push(`skills:${skillId}`);
    }
  }

  return uniqueStrings(targets);
}

function extractSkillTargetsFromSource(source: string): string[] {
  const match = source.match(/(?:^|\/)([^/]+)\/skill\.md$/i);
  return match?.[1] ? [`skills:${match[1]}`] : [];
}

function extractRunArtifactTargetsFromQuery(query: string): string[] {
  const targets: string[] = [];
  for (const match of query.matchAll(/\bstep\s+0*(\d{1,4})\b/gi)) {
    targets.push(`run_artifacts:step:${Number(match[1])}`);
  }
  for (const match of query.matchAll(/\b0*(\d{1,4})-(act|verify)\.md\b/gi)) {
    const step = Number(match[1]);
    const kind = match[2]?.toLowerCase();
    targets.push(`run_artifacts:step:${step}`);
    if (kind) {
      targets.push(`run_artifacts:file:steps/${String(step).padStart(3, "0")}-${kind}.md`);
    }
  }
  if (query.toLowerCase().includes("state.json")) {
    targets.push("run_artifacts:file:state.json");
  }
  return uniqueStrings(targets);
}

function extractRunArtifactTargetsFromSource(source: string, runPath: string): string[] {
  const normalizedRunPath = normalizePath(runPath);
  const relativeSource = source.startsWith(`${normalizedRunPath}/`)
    ? normalizePath(relative(normalizedRunPath, source))
    : source;
  const targets: string[] = [];
  if (relativeSource.endsWith("state.json")) {
    targets.push("run_artifacts:file:state.json");
  }
  const match = relativeSource.match(/(?:^|\/)steps\/0*(\d{1,4})-(act|verify)\.md$/i);
  if (match?.[1] && match?.[2]) {
    const step = Number(match[1]);
    const kind = match[2].toLowerCase();
    targets.push(`run_artifacts:step:${step}`);
    targets.push(`run_artifacts:file:steps/${String(step).padStart(3, "0")}-${kind}.md`);
  }
  return uniqueStrings(targets);
}

function extractProjectContextTargetsFromQuery(query: string): string[] {
  const lowered = query.toLowerCase();
  const knownFiles = ["soul.json", "system_prompt.md", "user_profile.json"];
  return knownFiles
    .filter((file) => lowered.includes(file.toLowerCase()))
    .map((file) => `project_context:file:${file}`);
}

function extractProjectContextTargetsFromSource(source: string, contextDir: string): string[] {
  const normalizedContextDir = normalizePath(contextDir);
  if (source.startsWith(`${normalizedContextDir}/`)) {
    return [`project_context:file:${normalizePath(relative(normalizedContextDir, source))}`];
  }
  const contextIndex = source.indexOf("/context/");
  if (contextIndex >= 0) {
    return [`project_context:file:${source.slice(contextIndex + "/context/".length)}`];
  }
  const fileName = source.split("/").pop();
  return fileName ? [`project_context:file:${fileName}`] : [];
}

function extractSessionTargetsFromQuery(query: string, knownLocations: ScoutKnownLocations): string[] {
  const lowered = query.toLowerCase();
  if ((lowered.includes("active session") || lowered.includes("current session")) && knownLocations.sessionPath) {
    return [`session:file:${normalizePath(knownLocations.sessionPath)}`];
  }
  return [];
}

function extractSessionTargetsFromSource(source: string, knownLocations: ScoutKnownLocations): string[] {
  if (knownLocations.sessionPath && source === normalizePath(knownLocations.sessionPath)) {
    return [`session:file:${source}`];
  }
  if (knownLocations.sessionDir) {
    const normalizedSessionDir = normalizePath(knownLocations.sessionDir);
    if (source.startsWith(`${normalizedSessionDir}/`)) {
      return [`session:file:${source}`];
    }
  }
  return source.includes("/sessions/") ? [`session:file:${source}`] : [];
}

function coversTargets(entryTargets: string[], requestedTargets: string[]): boolean {
  const entrySet = new Set(entryTargets);
  return requestedTargets.every((target) => entrySet.has(target));
}

function scopeSatisfies(entryScope: ContextSearchScope, requestedScope: ContextSearchScope): boolean {
  return entryScope === requestedScope || (entryScope === "both" && requestedScope !== "both");
}

function sameTargets(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function pruneEntries(entries: ContextCacheEntry[]): ContextCacheEntry[] {
  return [...entries]
    .sort((a, b) => b.lastUsedIteration - a.lastUsedIteration)
    .slice(0, MAX_CACHE_ENTRIES);
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function formatQueryForLog(query: string): string {
  const compact = query.replace(/\s+/g, " ").trim();
  if (compact.length <= 140) return compact;
  return `${compact.slice(0, 140)}...`;
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function hashQuery(value: string): string {
  let hash = 2166136261;
  const normalized = value.trim().toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36);
}
