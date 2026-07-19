import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  FindTasksRequest,
  FindTasksResponse,
  SetTaskStarRequest,
  SetTaskStarResponse,
  TaskCandidate,
  TaskDiscoveryReason,
  TaskDiscoveryTier,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { executeIdempotent } from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { readTaskCatalogEntry } from "../repositories/task-records.js";
import {
  readPreviousBoundTaskId,
  readTaskDiscoveryRows,
  recordTaskAccess,
  searchTaskIds,
  setTaskStar,
  type TaskDiscoveryRow,
} from "../repositories/task-discovery-records.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const ACTIVE_CONTEXT_LIMIT = 20;
const STRONG_GROUP_LIMIT = 5;
const TEXT_GROUP_LIMIT = 5;
const REFERENTIAL_CONTINUATION = /\b(continue|resume|keep going|carry on|pick up|where we left|same (?:task|project|work)|that (?:task|project|work)|previous (?:task|project|work)|next step)\b/i;

export class TaskDiscoveryService {
  constructor(
    private readonly database: ContextDatabase,
    private readonly now: () => string,
  ) {}

  find(input: FindTasksRequest): FindTasksResponse {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const now = this.now();
    const cutoff = new Date(Date.parse(now) - 30 * 24 * 60 * 60 * 1_000).toISOString();
    const rows = readTaskDiscoveryRows(this.database, cutoff);
    const query = normalizeText(input.query ?? input.currentText ?? "");
    const exactQuery = normalizeText(input.query ?? "");
    const explicitTaskIds = new Set(
      (input.query ?? input.currentText ?? "").toUpperCase().match(/T-\d{8}-\d{4}/g) ?? [],
    );
    const ftsIds = new Set(searchTaskIds(
      this.database,
      ftsExpression(query),
      Math.max(limit * 4, 50),
    ));
    const previousTaskId = input.sessionId && REFERENTIAL_CONTINUATION.test(input.currentText ?? "")
      ? readPreviousBoundTaskId(this.database, input.sessionId)
      : undefined;
    const exactTitleCounts = new Map<string, number>();
    for (const row of rows) {
      const title = normalizeText(row.title);
      exactTitleCounts.set(title, (exactTitleCounts.get(title) ?? 0) + 1);
    }
    const textMatchCount = query
      ? rows.filter((row) => ftsIds.has(row.taskId) || rowText(row).includes(query)).length
      : 0;
    const candidates = rows.map((row) => candidateForRow({
      row,
      query,
      exactQuery,
      explicitTaskIds,
      ftsMatch: ftsIds.has(row.taskId),
      uniqueTextMatch: textMatchCount === 1,
      exactTitleUnique: exactTitleCounts.get(normalizeText(row.title)) === 1,
      paths: input.paths ?? [],
      previousTaskId,
    }));
    const visible = candidates.filter((candidate) => {
      const exact = hasStrongReason(candidate);
      if (candidate.status === "archived" && !input.includeArchived && !exact) return false;
      if (input.query) {
        return exact || candidate.discovery.reasons.includes("text_match")
          || candidate.discovery.reasons.includes("matching_request");
      }
      switch (input.view ?? "relevant") {
        case "unfinished":
          return candidate.discovery.reasons.includes("unfinished_request");
        case "starred":
          return candidate.starred;
        case "recent":
          return Boolean(candidate.lastOpenedAt);
        case "frequent":
          return candidate.boundRunsLast30Days > 0;
        case "relevant":
          return true;
      }
    });
    const tasks = input.query || (input.view && input.view !== "relevant")
      ? [...visible].sort(compareCandidates).slice(0, limit)
      : defaultShortlist(visible, Math.min(limit, ACTIVE_CONTEXT_LIMIT));
    return { tasks };
  }

  recordAccess(input: {
    taskId: string;
    runId: string;
    kind: "opened" | "bound";
    at: string;
  }): boolean {
    const run = readRunEvidence(this.database, input.runId);
    if (!run || run.status !== "running"
      || (input.kind === "bound" && run.taskBinding?.taskId !== input.taskId)) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Task access must belong to the matching active run.",
        details: { taskId: input.taskId, runId: input.runId, kind: input.kind },
      });
    }
    return recordTaskAccess({ database: this.database, ...input });
  }

  setStar(input: SetTaskStarRequest): SetTaskStarResponse {
    const run = readRunEvidence(this.database, input.runId);
    if (!run || run.sessionId !== input.sessionId || run.status !== "running") {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Changing a task star requires the matching active run.",
        details: { sessionId: input.sessionId, runId: input.runId },
      });
    }
    if (!readTaskCatalogEntry(this.database, input.taskId)) {
      throw new GitContextServiceError({
        code: "TASK_NOT_FOUND",
        message: "Task does not exist.",
        details: { taskId: input.taskId },
      });
    }
    return executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "set_task_star",
      payload: input,
      now: input.at,
      execute: () => setTaskStar({
        database: this.database,
        taskId: input.taskId,
        starred: input.starred,
        at: input.at,
      }),
    });
  }
}

function candidateForRow(input: {
  row: TaskDiscoveryRow;
  query: string;
  exactQuery: string;
  explicitTaskIds: ReadonlySet<string>;
  ftsMatch: boolean;
  uniqueTextMatch: boolean;
  exactTitleUnique: boolean;
  paths: string[];
  previousTaskId?: string;
}): TaskCandidate {
  const reasons: TaskDiscoveryReason[] = [];
  if (input.exactQuery.toUpperCase() === input.row.taskId.toUpperCase()
    || input.explicitTaskIds.has(input.row.taskId.toUpperCase())) {
    reasons.push("exact_task_id");
  }
  if (input.query
    && input.exactTitleUnique
    && (input.exactQuery === normalizeText(input.row.title)
      || containsPhrase(input.query, input.row.title))) {
    reasons.push("exact_title");
  }
  if (input.paths.some((path) => pathOwnedBy(input.row.repositoryPath, path))) {
    reasons.push("owned_path");
  }
  if (input.previousTaskId === input.row.taskId) reasons.push("direct_continuation");
  if (input.query && input.row.currentRequestTitle
    && textOverlaps(input.query, input.row.currentRequestTitle)) {
    reasons.push("matching_request");
  }
  if (input.ftsMatch || (input.query && rowText(input.row).includes(input.query))) {
    reasons.push("text_match");
  }
  if (input.row.currentRequestStatus === "active"
    || input.row.currentRequestStatus === "blocked"
    || input.row.currentRequestStatus === "queued") {
    reasons.push("unfinished_request");
  }
  if (input.row.starred) reasons.push("starred");
  if (input.row.lastOpenedAt) reasons.push("recent");
  if (input.row.boundRunsLast30Days > 0) reasons.push("frequent");
  const tier: TaskDiscoveryTier = reasons.some((reason) =>
    reason === "exact_task_id"
      || reason === "exact_title"
      || reason === "owned_path"
      || reason === "direct_continuation")
    ? "definite"
    : input.uniqueTextMatch
      && (reasons.includes("text_match") || reasons.includes("matching_request"))
    ? "probable"
    : "candidate";
  return {
    taskId: input.row.taskId,
    title: input.row.title,
    objective: input.row.objective,
    status: input.row.status,
    lifecycleStatus: input.row.lifecycleStatus,
    repositoryHealth: input.row.repositoryHealth,
    ...(input.row.currentRequestId
      && input.row.currentRequestTitle
      && input.row.currentRequestStatus
      ? {
          currentRequest: {
            id: input.row.currentRequestId,
            title: input.row.currentRequestTitle,
            status: input.row.currentRequestStatus,
          },
        }
      : {}),
    head: input.row.head,
    workingDirectory: input.row.repositoryPath,
    updatedAt: input.row.updatedAt,
    discovery: { tier, reasons },
    starred: input.row.starred,
    ...(input.row.lastOpenedAt ? { lastOpenedAt: input.row.lastOpenedAt } : {}),
    boundRunsLast30Days: input.row.boundRunsLast30Days,
  };
}

function defaultShortlist(candidates: TaskCandidate[], limit: number): TaskCandidate[] {
  const result: TaskCandidate[] = [];
  const seen = new Set<string>();
  const append = (candidate: TaskCandidate): void => {
    if (result.length >= limit || seen.has(candidate.taskId)) return;
    seen.add(candidate.taskId);
    result.push(candidate);
  };
  candidates.filter(hasStrongReason).sort(compareCandidates)
    .slice(0, STRONG_GROUP_LIMIT).forEach(append);
  candidates.filter((candidate) => candidate.discovery.reasons.includes("text_match")
    || candidate.discovery.reasons.includes("matching_request"))
    .sort(compareCandidates).slice(0, TEXT_GROUP_LIMIT).forEach(append);
  const groups = [
    candidates.filter((candidate) => candidate.discovery.reasons.includes("unfinished_request")),
    candidates.filter((candidate) => candidate.starred),
    candidates.filter((candidate) => Boolean(candidate.lastOpenedAt)),
    candidates.filter((candidate) => candidate.boundRunsLast30Days > 0),
  ].map((group) => group.sort(compareCandidates));
  let offset = 0;
  while (result.length < limit && groups.some((group) => offset < group.length)) {
    for (const group of groups) {
      const candidate = group[offset];
      if (candidate) append(candidate);
      if (result.length >= limit) break;
    }
    offset++;
  }
  candidates.sort(compareCandidates).forEach(append);
  return result;
}

function compareCandidates(left: TaskCandidate, right: TaskCandidate): number {
  const tier = { definite: 0, probable: 1, candidate: 2 } as const;
  return tier[left.discovery.tier] - tier[right.discovery.tier]
    || strongReasonRank(left) - strongReasonRank(right)
    || Number(right.starred) - Number(left.starred)
    || right.boundRunsLast30Days - left.boundRunsLast30Days
    || (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? "")
    || right.updatedAt.localeCompare(left.updatedAt)
    || right.taskId.localeCompare(left.taskId);
}

function strongReasonRank(candidate: TaskCandidate): number {
  const reasons = candidate.discovery.reasons;
  if (reasons.includes("exact_task_id")) return 0;
  if (reasons.includes("owned_path")) return 1;
  if (reasons.includes("exact_title")) return 2;
  if (reasons.includes("direct_continuation")) return 3;
  return 4;
}

function hasStrongReason(candidate: TaskCandidate): boolean {
  return candidate.discovery.reasons.some((reason) =>
    reason === "exact_task_id"
      || reason === "exact_title"
      || reason === "owned_path"
      || reason === "direct_continuation");
}

function ftsExpression(value: string): string {
  return [...new Set(value.split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length >= 2))]
    .slice(0, 20)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function rowText(row: TaskDiscoveryRow): string {
  return normalizeText([
    row.taskId,
    row.title,
    row.objective,
    row.currentRequestTitle ?? "",
    row.repositoryPath,
  ].join(" "));
}

function textOverlaps(query: string, value: string): boolean {
  const normalized = normalizeText(value);
  if (normalized.length < 4) return false;
  return query.includes(normalized) || normalized.includes(query);
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalizePhrase = (value: string) => value.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const normalizedText = normalizePhrase(text);
  const normalizedPhrase = normalizePhrase(phrase);
  if (normalizedPhrase.length < 4) return false;
  return (` ${normalizedText} `).includes(` ${normalizedPhrase} `);
}

function pathOwnedBy(repositoryPath: string, candidate: string): boolean {
  const target = resolve(candidate);
  const root = resolve(repositoryPath);
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}
