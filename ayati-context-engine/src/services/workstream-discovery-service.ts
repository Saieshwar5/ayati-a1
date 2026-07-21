import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  FindWorkstreamsRequest,
  FindWorkstreamsResponse,
  SetWorkstreamStarRequest,
  SetWorkstreamStarResponse,
  ResourceRef,
  WorkstreamCandidate,
  WorkstreamDiscoveryReason,
  WorkstreamDiscoveryTier,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { executeIdempotent } from "../database/idempotency.js";
import { ContextEngineServiceError } from "../errors.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { readWorkstreamCatalogEntry } from "../repositories/workstream-records.js";
import {
  readWorkstreamResourceDiscoveryIndex,
  searchResourceIdsByText,
  type WorkstreamResourceDiscoveryIndex,
} from "../repositories/resource-records.js";
import {
  readPreviousBoundWorkstreamId,
  readWorkstreamDiscoveryRows,
  recordWorkstreamAccess,
  searchWorkstreamIds,
  setWorkstreamStar,
  type WorkstreamDiscoveryRow,
} from "../repositories/workstream-discovery-records.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const ACTIVE_CONTEXT_LIMIT = 20;
const STRONG_GROUP_LIMIT = 5;
const TEXT_GROUP_LIMIT = 5;
const REFERENTIAL_CONTINUATION = /\b(continue|resume|keep going|carry on|pick up|where we left|same (?:workstream|project|work)|that (?:workstream|project|work)|previous (?:workstream|project|work)|next step)\b/i;

export class WorkstreamDiscoveryService {
  constructor(
    private readonly database: ContextDatabase,
    private readonly now: () => string,
  ) {}

  find(input: FindWorkstreamsRequest): FindWorkstreamsResponse {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const now = this.now();
    const cutoff = new Date(Date.parse(now) - 30 * 24 * 60 * 60 * 1_000).toISOString();
    const rows = readWorkstreamDiscoveryRows(this.database, cutoff);
    const query = normalizeText(input.query ?? input.currentText ?? "");
    const exactQuery = normalizeText(input.query ?? "");
    const explicitWorkstreamIds = new Set(
      (input.query ?? input.currentText ?? "").toUpperCase().match(/W-\d{8}-\d{4}/g) ?? [],
    );
    const explicitResourceIds = new Set(
      (input.query ?? input.currentText ?? "").toUpperCase().match(/RES-[0-9A-F]{24}/g) ?? [],
    );
    const ftsIds = new Set(searchWorkstreamIds(
      this.database,
      ftsExpression(query),
      Math.max(limit * 4, 50),
    ));
    const resourceIndex = readWorkstreamResourceDiscoveryIndex(this.database);
    const matchingResourceIds = searchResourceIdsByText(
      this.database,
      ftsExpression(query),
      Math.max(limit * 20, 200),
    );
    const previousWorkstreamId = input.streamId && REFERENTIAL_CONTINUATION.test(input.currentText ?? "")
      ? readPreviousBoundWorkstreamId(this.database, input.streamId)
      : undefined;
    const exactTitleCounts = new Map<string, number>();
    for (const row of rows) {
      const title = normalizeText(row.title);
      exactTitleCounts.set(title, (exactTitleCounts.get(title) ?? 0) + 1);
    }
    const textMatchCount = query
      ? rows.filter((row) => ftsIds.has(row.workstreamId)
        || rowText(row).includes(query)
        || (resourceIndex.get(row.workstreamId)?.resources ?? [])
          .some((resource) => matchingResourceIds.has(resource.resourceId))).length
      : 0;
    const candidates = rows.map((row) => candidateForRow({
      row,
      query,
      exactQuery,
      explicitWorkstreamIds,
      ftsMatch: ftsIds.has(row.workstreamId),
      uniqueTextMatch: textMatchCount === 1,
      exactTitleUnique: exactTitleCounts.get(normalizeText(row.title)) === 1,
      paths: input.paths ?? [],
      previousWorkstreamId,
      explicitResourceIds,
      matchingResourceIds,
      resources: resourceIndex.get(row.workstreamId),
    }));
    const visible = candidates.filter((candidate) => {
      const exact = hasStrongReason(candidate);
      if (candidate.status === "archived" && !input.includeArchived && !exact) return false;
      if (input.query) {
        return exact || candidate.discovery.reasons.includes("text_match")
          || candidate.discovery.reasons.includes("matching_request")
          || candidate.discovery.reasons.includes("resource_match");
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
    const workstreams = input.query || (input.view && input.view !== "relevant")
      ? [...visible].sort(compareCandidates).slice(0, limit)
      : defaultShortlist(visible, Math.min(limit, ACTIVE_CONTEXT_LIMIT));
    return { workstreams };
  }

  recordAccess(input: {
    workstreamId: string;
    runId: string;
    kind: "opened" | "bound";
    at: string;
  }): boolean {
    const run = readRunEvidence(this.database, input.runId);
    if (!run || run.status !== "running"
      || (input.kind === "bound" && run.workstreamBinding?.workstreamId !== input.workstreamId)) {
      throw new ContextEngineServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Workstream access must belong to the matching active run.",
        details: { workstreamId: input.workstreamId, runId: input.runId, kind: input.kind },
      });
    }
    return recordWorkstreamAccess({ database: this.database, ...input });
  }

  setStar(input: SetWorkstreamStarRequest): SetWorkstreamStarResponse {
    return executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "set_workstream_star",
      payload: input,
      now: input.at,
      execute: () => {
        const run = readRunEvidence(this.database, input.runId);
        if (!run || run.status !== "running") {
          throw new ContextEngineServiceError({
            code: "RUN_NOT_ACTIVE",
            message: "Changing a workstream star requires the matching active run.",
            details: { runId: input.runId },
          });
        }
        if (!readWorkstreamCatalogEntry(this.database, input.workstreamId)) {
          throw new ContextEngineServiceError({
            code: "WORKSTREAM_NOT_FOUND",
            message: "Workstream does not exist.",
            details: { workstreamId: input.workstreamId },
          });
        }
        return setWorkstreamStar({
          database: this.database,
          workstreamId: input.workstreamId,
          starred: input.starred,
          at: input.at,
        });
      },
    });
  }
}

function candidateForRow(input: {
  row: WorkstreamDiscoveryRow;
  query: string;
  exactQuery: string;
  explicitWorkstreamIds: ReadonlySet<string>;
  ftsMatch: boolean;
  uniqueTextMatch: boolean;
  exactTitleUnique: boolean;
  paths: string[];
  previousWorkstreamId?: string;
  explicitResourceIds: ReadonlySet<string>;
  matchingResourceIds: ReadonlySet<string>;
  resources?: WorkstreamResourceDiscoveryIndex;
}): WorkstreamCandidate {
  const reasons: WorkstreamDiscoveryReason[] = [];
  const resources = input.resources?.resources ?? [];
  if (input.exactQuery.toUpperCase() === input.row.workstreamId.toUpperCase()
    || input.explicitWorkstreamIds.has(input.row.workstreamId.toUpperCase())) {
    reasons.push("exact_workstream_id");
  }
  if (input.query
    && input.exactTitleUnique
    && (input.exactQuery === normalizeText(input.row.title)
      || containsPhrase(input.query, input.row.title))) {
    reasons.push("exact_title");
  }
  if (resources.some((resource) => input.explicitResourceIds.has(resource.resourceId))) {
    reasons.push("exact_resource_id");
  }
  if (input.paths.some((path) => resources.some((resource) => resourceOwnsPath(resource, path)))) {
    reasons.push("owned_resource");
  }
  if (input.previousWorkstreamId === input.row.workstreamId) reasons.push("direct_continuation");
  if (input.query && input.row.currentRequestTitle
    && textOverlaps(input.query, input.row.currentRequestTitle)) {
    reasons.push("matching_request");
  }
  if (input.ftsMatch || (input.query && rowText(input.row).includes(input.query))) {
    reasons.push("text_match");
  }
  if (resources.some((resource) => input.matchingResourceIds.has(resource.resourceId))) {
    reasons.push("resource_match");
  }
  if (input.row.currentRequestStatus === "active"
    || input.row.currentRequestStatus === "blocked"
    || input.row.currentRequestStatus === "queued") {
    reasons.push("unfinished_request");
  }
  if (input.row.starred) reasons.push("starred");
  if (input.row.lastOpenedAt) reasons.push("recent");
  if (input.row.boundRunsLast30Days > 0) reasons.push("frequent");
  const tier: WorkstreamDiscoveryTier = reasons.some((reason) =>
    reason === "exact_workstream_id"
      || reason === "exact_resource_id"
      || reason === "exact_title"
      || reason === "owned_resource"
      || reason === "direct_continuation")
    ? "definite"
    : input.uniqueTextMatch
      && (reasons.includes("text_match")
        || reasons.includes("matching_request")
        || reasons.includes("resource_match"))
    ? "probable"
    : "candidate";
  return {
    workstreamId: input.row.workstreamId,
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
    primaryResources: input.resources?.primaryResources ?? [],
    updatedAt: input.row.updatedAt,
    discovery: { tier, reasons },
    starred: input.row.starred,
    ...(input.row.lastOpenedAt ? { lastOpenedAt: input.row.lastOpenedAt } : {}),
    boundRunsLast30Days: input.row.boundRunsLast30Days,
  };
}

function defaultShortlist(candidates: WorkstreamCandidate[], limit: number): WorkstreamCandidate[] {
  const result: WorkstreamCandidate[] = [];
  const seen = new Set<string>();
  const append = (candidate: WorkstreamCandidate): void => {
    if (result.length >= limit || seen.has(candidate.workstreamId)) return;
    seen.add(candidate.workstreamId);
    result.push(candidate);
  };
  candidates.filter(hasStrongReason).sort(compareCandidates)
    .slice(0, STRONG_GROUP_LIMIT).forEach(append);
  candidates.filter((candidate) => candidate.discovery.reasons.includes("text_match")
    || candidate.discovery.reasons.includes("matching_request")
    || candidate.discovery.reasons.includes("resource_match"))
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

function compareCandidates(left: WorkstreamCandidate, right: WorkstreamCandidate): number {
  const tier = { definite: 0, probable: 1, candidate: 2 } as const;
  return tier[left.discovery.tier] - tier[right.discovery.tier]
    || strongReasonRank(left) - strongReasonRank(right)
    || Number(right.starred) - Number(left.starred)
    || right.boundRunsLast30Days - left.boundRunsLast30Days
    || (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? "")
    || right.updatedAt.localeCompare(left.updatedAt)
    || right.workstreamId.localeCompare(left.workstreamId);
}

function strongReasonRank(candidate: WorkstreamCandidate): number {
  const reasons = candidate.discovery.reasons;
  if (reasons.includes("exact_workstream_id")) return 0;
  if (reasons.includes("exact_resource_id")) return 1;
  if (reasons.includes("owned_resource")) return 2;
  if (reasons.includes("exact_title")) return 3;
  if (reasons.includes("direct_continuation")) return 4;
  return 5;
}

function hasStrongReason(candidate: WorkstreamCandidate): boolean {
  return candidate.discovery.reasons.some((reason) =>
    reason === "exact_workstream_id"
      || reason === "exact_resource_id"
      || reason === "exact_title"
      || reason === "owned_resource"
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

function rowText(row: WorkstreamDiscoveryRow): string {
  return normalizeText([
    row.workstreamId,
    row.title,
    row.objective,
    row.currentRequestTitle ?? "",
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

function resourceOwnsPath(resource: ResourceRef, candidate: string): boolean {
  if (resource.locator.kind !== "filesystem") return false;
  const target = resolve(candidate);
  const root = resolve(resource.locator.path);
  if (resource.kind !== "directory" && resource.kind !== "git_repository") {
    return root === target;
  }
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}
