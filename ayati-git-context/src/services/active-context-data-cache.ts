import { createHash } from "node:crypto";
import type {
  ReadContextProjection,
  SessionResourcesProjection,
  WorkstreamCandidate,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

export const DEFAULT_WORKSTREAM_CANDIDATE_CACHE_INTERVAL_MS = 5 * 60_000;

interface WorkstreamCandidateCacheEntry {
  catalogRevision: string;
  loadedAtMs: number;
  candidates: WorkstreamCandidate[];
}

export interface WorkstreamCandidateLoadInput {
  limit: number;
  sessionId?: string;
  currentText?: string;
}

export class ActiveContextDataCache {
  private readonly readContextBySession = new Map<string, ReadContextProjection>();
  private readonly resourcesBySession = new Map<
    string,
    SessionResourcesProjection | null
  >();
  private readonly workstreamCandidatesByKey = new Map<string, WorkstreamCandidateCacheEntry>();

  constructor(private readonly options: {
    database: ContextDatabase;
    loadReadContext: (sessionId: string) => ReadContextProjection;
    loadResources: (sessionId: string) => SessionResourcesProjection | undefined;
    loadWorkstreamCandidates: (input: WorkstreamCandidateLoadInput) => Promise<WorkstreamCandidate[]>;
    workstreamCandidateMaxAgeMs: number;
    now: () => string;
  }) {}

  readContext(sessionId: string): ReadContextProjection {
    const cached = this.readContextBySession.get(sessionId);
    if (cached) return cached;
    const loaded = this.options.loadReadContext(sessionId);
    this.readContextBySession.set(sessionId, loaded);
    return loaded;
  }

  resources(sessionId: string): SessionResourcesProjection | undefined {
    const cached = this.resourcesBySession.get(sessionId);
    if (cached !== undefined) return cached ?? undefined;
    const loaded = this.options.loadResources(sessionId);
    this.resourcesBySession.set(sessionId, loaded ?? null);
    return loaded;
  }

  async workstreamCandidates(input: WorkstreamCandidateLoadInput): Promise<WorkstreamCandidate[]> {
    const catalogRevision = workstreamCatalogRevision(this.options.database);
    const key = workstreamCandidateKey(input);
    const cached = this.workstreamCandidatesByKey.get(key);
    const ageMs = cached
      ? timestampMilliseconds(this.options.now()) - cached.loadedAtMs
      : undefined;
    if (cached
      && cached.catalogRevision === catalogRevision
      && ageMs !== undefined
      && ageMs >= 0
      && ageMs <= this.options.workstreamCandidateMaxAgeMs) {
      return cached.candidates;
    }
    const candidates = await this.options.loadWorkstreamCandidates(input);
    this.workstreamCandidatesByKey.set(key, {
      catalogRevision,
      loadedAtMs: timestampMilliseconds(this.options.now()),
      candidates,
    });
    return candidates;
  }

  invalidateReadContext(sessionId: string): void {
    this.readContextBySession.delete(sessionId);
  }

  invalidateResources(sessionId: string): void {
    this.resourcesBySession.delete(sessionId);
  }

  invalidateWorkstreamCandidates(): void {
    this.workstreamCandidatesByKey.clear();
  }

  clear(): void {
    this.readContextBySession.clear();
    this.resourcesBySession.clear();
    this.workstreamCandidatesByKey.clear();
  }
}

function workstreamCatalogRevision(database: ContextDatabase): string {
  const rows = database.prepare([
    "SELECT workstream_id, repository_path, branch, head_sha, title_cache, objective_cache,",
    "status, lifecycle_status, repository_health, current_request_id,",
    "current_request_title, current_request_status, updated_at",
    "FROM workstreams ORDER BY workstream_id",
  ].join(" ")).all() as unknown[];
  const preferences = database.prepare([
    "SELECT workstream_id, starred, starred_at, updated_at",
    "FROM workstream_preferences ORDER BY workstream_id",
  ].join(" ")).all() as unknown[];
  const accesses = database.prepare([
    "SELECT workstream_id, run_id, access_kind, accessed_at",
    "FROM workstream_accesses ORDER BY workstream_id, run_id, access_kind",
  ].join(" ")).all() as unknown[];
  const resourceBindings = database.prepare([
    "SELECT wr.workstream_id, wr.resource_id, wr.role, wr.access, wr.is_primary, wr.last_used_at,",
    "r.display_name, r.description, r.aliases_json, r.locator_key, r.current_version_key,",
    "r.availability, r.updated_at FROM workstream_resources wr",
    "JOIN resources r ON r.resource_id = wr.resource_id",
    "ORDER BY wr.workstream_id, wr.resource_id, wr.role",
  ].join(" ")).all() as unknown[];
  return hash(JSON.stringify({ rows, preferences, accesses, resourceBindings }));
}

function workstreamCandidateKey(input: WorkstreamCandidateLoadInput): string {
  return String(input.limit) + ":" + hash(JSON.stringify({
    sessionId: input.sessionId ?? null,
    currentText: input.currentText ?? null,
  }));
}

function timestampMilliseconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
