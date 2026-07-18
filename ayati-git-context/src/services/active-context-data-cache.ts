import { createHash } from "node:crypto";
import type {
  ReadContextProjection,
  SessionAttachmentsProjection,
  TaskCandidate,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

export const DEFAULT_TASK_CANDIDATE_CACHE_INTERVAL_MS = 5 * 60_000;

interface TaskCandidateCacheEntry {
  catalogRevision: string;
  loadedAtMs: number;
  candidates: TaskCandidate[];
}

export class ActiveContextDataCache {
  private readonly readContextBySession = new Map<string, ReadContextProjection>();
  private readonly attachmentsBySession = new Map<
    string,
    SessionAttachmentsProjection | null
  >();
  private readonly taskCandidatesByLimit = new Map<number, TaskCandidateCacheEntry>();

  constructor(private readonly options: {
    database: ContextDatabase;
    loadReadContext: (sessionId: string) => ReadContextProjection;
    loadAttachments: (sessionId: string) => SessionAttachmentsProjection | undefined;
    loadTaskCandidates: (limit: number) => Promise<TaskCandidate[]>;
    taskCandidateMaxAgeMs: number;
    now: () => string;
  }) {}

  readContext(sessionId: string): ReadContextProjection {
    const cached = this.readContextBySession.get(sessionId);
    if (cached) return cached;
    const loaded = this.options.loadReadContext(sessionId);
    this.readContextBySession.set(sessionId, loaded);
    return loaded;
  }

  attachments(sessionId: string): SessionAttachmentsProjection | undefined {
    const cached = this.attachmentsBySession.get(sessionId);
    if (cached !== undefined) return cached ?? undefined;
    const loaded = this.options.loadAttachments(sessionId);
    this.attachmentsBySession.set(sessionId, loaded ?? null);
    return loaded;
  }

  async taskCandidates(limit: number): Promise<TaskCandidate[]> {
    const catalogRevision = taskCatalogRevision(this.options.database);
    const cached = this.taskCandidatesByLimit.get(limit);
    const ageMs = cached
      ? timestampMilliseconds(this.options.now()) - cached.loadedAtMs
      : undefined;
    if (cached
      && cached.catalogRevision === catalogRevision
      && ageMs !== undefined
      && ageMs >= 0
      && ageMs <= this.options.taskCandidateMaxAgeMs) {
      return cached.candidates;
    }
    const candidates = await this.options.loadTaskCandidates(limit);
    this.taskCandidatesByLimit.set(limit, {
      catalogRevision,
      loadedAtMs: timestampMilliseconds(this.options.now()),
      candidates,
    });
    return candidates;
  }

  invalidateReadContext(sessionId: string): void {
    this.readContextBySession.delete(sessionId);
  }

  invalidateAttachments(sessionId: string): void {
    this.attachmentsBySession.delete(sessionId);
  }

  invalidateTaskCandidates(): void {
    this.taskCandidatesByLimit.clear();
  }

  clear(): void {
    this.readContextBySession.clear();
    this.attachmentsBySession.clear();
    this.taskCandidatesByLimit.clear();
  }
}

function taskCatalogRevision(database: ContextDatabase): string {
  const rows = database.prepare([
    "SELECT task_id, repository_path, branch,",
    "head_sha, title_cache, objective_cache, status, updated_at",
    "FROM tasks ORDER BY task_id",
  ].join(" ")).all() as unknown[];
  return hash(JSON.stringify(rows));
}

function timestampMilliseconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
