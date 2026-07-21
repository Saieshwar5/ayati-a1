import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import type {
  ResourceAdmission,
  ResourceAvailability,
  ResourceEvent,
  ResourceId,
  ResourceKind,
  ResourceOrigin,
  ResourcePublicLocator,
  ResourceRef,
  ResourceRole,
  ResourceVersion,
  AgentStreamResourcesProjection,
  WorkstreamResourceBinding,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import {
  canonicalizeWorkstreamResourceBindings,
  type WorkstreamResourceBindingInput,
} from "../resources/workstream-resource-binding-policy.js";

interface ResourceRow {
  resource_id: string;
  kind: ResourceKind;
  origin: ResourceOrigin;
  locator_kind: "filesystem" | "managed_blob" | "url" | "external";
  locator_key: string;
  locator_json: string;
  display_name: string;
  description: string;
  aliases_json: string;
  metadata_status: "fallback" | "enriched" | "stale";
  described_version_key: string | null;
  media_type: string | null;
  size_bytes: number | null;
  content_hash: string | null;
  current_version_key: string;
  current_version_json: string;
  availability: ResourceAvailability;
  created_at: string;
  updated_at: string;
}

interface WorkstreamResourceRow extends ResourceRow {
  workstream_id: string;
  role: ResourceRole;
  access: "read" | "mutate";
  is_primary: number;
  bound_at: string;
  last_used_at: string;
}

export type ObservedResourceAdmission = ResourceAdmission & { version: ResourceVersion };

export interface ResourceSearchRecord {
  resource: ResourceRef;
  workstreamIds: string[];
  roles: ResourceRole[];
  lastUsedAt?: string;
}

export interface WorkstreamResourceDiscoveryIndex {
  resources: ResourceRef[];
  primaryResources: ResourceRef[];
  searchableText: string;
}

export function admitMessageResources(
  database: ContextDatabase,
  input: {
    messageId: string;
    runId: string;
    admissions: ObservedResourceAdmission[];
    at: string;
  },
): ResourceRef[] {
  const result: ResourceRef[] = [];
  for (let ordinal = 0; ordinal < input.admissions.length; ordinal += 1) {
    const admission = input.admissions[ordinal];
    if (!admission) continue;
    const { resource, created } = upsertResource(database, {
      admission,
      runId: input.runId,
      at: input.at,
    });
    database.prepare([
      "INSERT OR IGNORE INTO message_resources(message_id, resource_id, role, ordinal, created_at)",
      "VALUES (?, ?, ?, ?, ?)",
    ].join(" ")).run(
      input.messageId,
      resource.resourceId,
      admission.role,
      ordinal,
      input.at,
    );
    recordResourceAccess(database, resource.resourceId, input.runId, "opened", input.at);
    if (created) {
      insertResourceEvent(database, {
        eventId: stableEventId(input.runId, resource.resourceId, "registered", admission.admissionId),
        resourceId: resource.resourceId,
        runId: input.runId,
        type: "registered",
        afterVersion: resource.version,
        verification: { admissionId: admission.admissionId, source: "turn_preparation" },
        summary: "Registered " + resource.displayName + " from the incoming turn.",
        at: input.at,
      });
    }
    result.push(resource);
  }
  return result;
}

export function upsertResource(
  database: ContextDatabase,
  input: {
    admission: ObservedResourceAdmission;
    runId: string;
    at: string;
  },
): { resource: ResourceRef; created: boolean } {
  const locator = normalizeLocator(input.admission.locator);
  const locatorKey = resourceLocatorKey(locator);
  const existing = readResourceRowByLocator(database, locatorKey);
  const resourceId = existing?.resource_id
    ?? (locator.kind === "managed_blob" ? locator.resourceId : resourceIdForLocator(locatorKey));
  if (existing && existing.kind !== input.admission.kind) {
    throw new ContextEngineServiceError({
      code: "RESOURCE_CONFLICT",
      message: "The resource locator is already registered with a different kind.",
      details: {
        resourceId,
        existingKind: existing.kind,
        requestedKind: input.admission.kind,
      },
    });
  }
  const displayName = normalizeRequired(input.admission.displayName, "resource display name", 500);
  const suppliedDescription = normalizeOptional(input.admission.description, 2_000);
  const suppliedAliases = normalizeAliases(input.admission.aliases ?? []);
  const fallback = fallbackMetadata(input.admission.kind, displayName, locator);
  const description = suppliedDescription ?? existing?.description ?? fallback.description;
  const aliases = suppliedAliases.length > 0
    ? suppliedAliases
    : existing
      ? parseStringArray(existing.aliases_json, existing.resource_id)
      : fallback.aliases;
  const enriched = Boolean(suppliedDescription || suppliedAliases.length > 0);
  const metadataStatus = enriched
    ? "enriched"
    : existing?.metadata_status === "enriched"
      && existing.described_version_key === input.admission.version.key
      ? "enriched"
      : existing?.metadata_status === "enriched"
        ? "stale"
        : "fallback";
  const describedVersionKey = enriched
    ? input.admission.version.key
    : existing?.described_version_key ?? null;
  const availability = availabilityFor(input.admission.version, describedVersionKey);
  const versionJson = JSON.stringify(input.admission.version);
  const sizeBytes = input.admission.version.sizeBytes ?? null;
  const contentHash = input.admission.version.sha256 ?? null;

  if (existing) {
    database.prepare([
      "UPDATE resources SET locator_json = ?, display_name = ?, description = ?, aliases_json = ?,",
      "metadata_status = ?, described_version_key = ?, media_type = ?, size_bytes = ?,",
      "content_hash = ?, current_version_key = ?, current_version_json = ?, availability = ?,",
      "last_verified_run_id = ?, last_verified_at = ?, updated_at = ? WHERE resource_id = ?",
    ].join(" ")).run(
      JSON.stringify(locator),
      displayName,
      description,
      JSON.stringify(aliases),
      metadataStatus,
      describedVersionKey,
      input.admission.mediaType ?? existing.media_type,
      sizeBytes,
      contentHash,
      input.admission.version.key,
      versionJson,
      availability,
      input.runId,
      input.at,
      input.at,
      resourceId,
    );
  } else {
    database.prepare([
      "INSERT INTO resources(",
      "resource_id, kind, origin, locator_kind, locator_key, locator_json, display_name,",
      "description, aliases_json, metadata_status, described_version_key, media_type, size_bytes,",
      "content_hash, current_version_key, current_version_json, availability, metadata_json,",
      "created_by_run_id, last_verified_run_id, last_verified_at, created_at, updated_at",
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)",
    ].join(" ")).run(
      resourceId,
      input.admission.kind,
      input.admission.origin,
      locator.kind,
      locatorKey,
      JSON.stringify(locator),
      displayName,
      description,
      JSON.stringify(aliases),
      metadataStatus,
      describedVersionKey,
      input.admission.mediaType ?? null,
      sizeBytes,
      contentHash,
      input.admission.version.key,
      versionJson,
      availability,
      input.runId,
      input.runId,
      input.at,
      input.at,
      input.at,
    );
  }
  refreshResourceSearch(database, resourceId);
  const resource = readResource(database, resourceId);
  if (!resource) throw new Error("Resource could not be read after admission: " + resourceId);
  return { resource, created: !existing };
}

export function readResource(
  database: ContextDatabase,
  resourceId: ResourceId,
): ResourceRef | undefined {
  const row = database.prepare(resourceSelect() + " FROM resources WHERE resource_id = ?")
    .get(resourceId) as ResourceRow | undefined;
  return row ? resourceRef(row) : undefined;
}

export function readResourceByLocator(
  database: ContextDatabase,
  locator: ResourcePublicLocator,
): ResourceRef | undefined {
  const row = readResourceRowByLocator(database, resourceLocatorKey(normalizeLocator(locator)));
  return row ? resourceRef(row) : undefined;
}

export function findResources(
  database: ContextDatabase,
  input: {
    query?: string;
    resourceIds?: string[];
    locators?: string[];
    workstreamId?: string;
    includeMissing: boolean;
    limit: number;
  },
): ResourceSearchRecord[] {
  const ids = new Set<string>();
  for (const resourceId of input.resourceIds ?? []) {
    if (readResource(database, resourceId)) ids.add(resourceId);
  }
  for (const locator of input.locators ?? []) {
    const rows = database.prepare("SELECT resource_id FROM resources WHERE locator_key = ? OR locator_key LIKE ?")
      .all(locator, "%" + locator + "%") as unknown as Array<{ resource_id: string }>;
    for (const row of rows) ids.add(row.resource_id);
  }
  if (input.workstreamId) {
    const rows = database.prepare([
      "SELECT resource_id FROM workstream_resources WHERE workstream_id = ?",
      "ORDER BY is_primary DESC, last_used_at DESC",
    ].join(" ")).all(input.workstreamId) as unknown as Array<{ resource_id: string }>;
    for (const row of rows) ids.add(row.resource_id);
  }
  const query = input.query?.trim();
  if (query) {
    const ftsQuery = query.split(/\s+/).map((token) => '"' + token.replaceAll('"', '""') + '"*').join(" AND ");
    const rows = database.prepare([
      "SELECT resource_id FROM resource_search WHERE resource_search MATCH ?",
      "ORDER BY bm25(resource_search), resource_id LIMIT ?",
    ].join(" ")).all(ftsQuery, input.limit) as unknown as Array<{ resource_id: string }>;
    for (const row of rows) ids.add(row.resource_id);
  }
  if (ids.size === 0 && !query && !input.workstreamId
    && (input.resourceIds?.length ?? 0) === 0 && (input.locators?.length ?? 0) === 0) {
    const rows = database.prepare([
      "SELECT resource_id FROM resources",
      ...(input.includeMissing ? [] : ["WHERE availability NOT IN ('missing', 'deleted')"]),
      "ORDER BY updated_at DESC, resource_id LIMIT ?",
    ].join(" ")).all(input.limit) as unknown as Array<{ resource_id: string }>;
    for (const row of rows) ids.add(row.resource_id);
  }
  return [...ids]
    .map((resourceId) => resourceSearchRecord(database, resourceId))
    .filter((record): record is ResourceSearchRecord => Boolean(record))
    .filter((record) => input.includeMissing
      || (record.resource.availability !== "missing" && record.resource.availability !== "deleted"))
    .sort((left, right) => right.resource.updatedAt.localeCompare(left.resource.updatedAt)
      || left.resource.resourceId.localeCompare(right.resource.resourceId))
    .slice(0, input.limit);
}

export function readWorkstreamResourceDiscoveryIndex(
  database: ContextDatabase,
): Map<string, WorkstreamResourceDiscoveryIndex> {
  const rows = database.prepare([
    resourceSelect("r"),
    ", wr.workstream_id, wr.role, wr.access, wr.is_primary, wr.bound_at, wr.last_used_at",
    "FROM resources r JOIN workstream_resources wr ON wr.resource_id = r.resource_id",
    "ORDER BY wr.workstream_id, wr.is_primary DESC, wr.last_used_at DESC, r.resource_id",
  ].join(" ")).all() as unknown as WorkstreamResourceRow[];
  const resourcesByWorkstream = new Map<string, Map<string, ResourceRef>>();
  const primaryIdsByWorkstream = new Map<string, Set<string>>();
  for (const row of rows) {
    const resources = resourcesByWorkstream.get(row.workstream_id) ?? new Map<string, ResourceRef>();
    resources.set(row.resource_id, resourceRef(row));
    resourcesByWorkstream.set(row.workstream_id, resources);
    if (row.is_primary === 1) {
      const primaryIds = primaryIdsByWorkstream.get(row.workstream_id) ?? new Set<string>();
      primaryIds.add(row.resource_id);
      primaryIdsByWorkstream.set(row.workstream_id, primaryIds);
    }
  }
  const result = new Map<string, WorkstreamResourceDiscoveryIndex>();
  for (const [workstreamId, resourceMap] of resourcesByWorkstream) {
    const resources = [...resourceMap.values()];
    const primaryIds = primaryIdsByWorkstream.get(workstreamId) ?? new Set<string>();
    result.set(workstreamId, {
      resources,
      primaryResources: resources.filter((resource) => primaryIds.has(resource.resourceId)),
      searchableText: resources.map((resource) => [
        resource.resourceId,
        resource.displayName,
        resource.description,
        ...resource.aliases,
        resourceLocatorKey(resource.locator),
      ].join(" ")).join("\n"),
    });
  }
  return result;
}

export function searchResourceIdsByText(
  database: ContextDatabase,
  matchExpression: string,
  limit: number,
): Set<string> {
  if (!matchExpression) return new Set();
  const rows = database.prepare([
    "SELECT resource_id FROM resource_search WHERE resource_search MATCH ?",
    "ORDER BY bm25(resource_search), resource_id LIMIT ?",
  ].join(" ")).all(matchExpression, limit) as unknown as Array<{ resource_id: string }>;
  return new Set(rows.map((row) => row.resource_id));
}

export function bindResourcesToWorkstream(
  database: ContextDatabase,
  input: {
    runId: string;
    workstreamId: string;
    requestId: string;
    bindings: WorkstreamResourceBindingInput[];
    at: string;
  },
): WorkstreamResourceBinding[] {
  const run = database.prepare([
    "SELECT workstream_id, bound_request_id, status FROM runs WHERE run_id = ?",
  ].join(" ")).get(input.runId) as {
    workstream_id: string | null;
    bound_request_id: string | null;
    status: string;
  } | undefined;
  if (!run || run.status !== "running" || run.workstream_id !== input.workstreamId
    || run.bound_request_id !== input.requestId) {
    throw new ContextEngineServiceError({
      code: "RUN_WORKSTREAM_BINDING_REQUIRED",
      message: "Resources may be bound only through the matching active workstream run.",
      details: { runId: input.runId, workstreamId: input.workstreamId },
    });
  }
  const bindings = canonicalizeWorkstreamResourceBindings(input.bindings);
  const requestedPrimary = bindings.filter((binding) => binding.primary);
  if (requestedPrimary[0]) {
    const existing = database.prepare([
      "SELECT resource_id FROM workstream_resources WHERE workstream_id = ? AND is_primary = 1",
    ].join(" ")).get(input.workstreamId) as { resource_id: string } | undefined;
    if (existing && existing.resource_id !== requestedPrimary[0].resourceId) {
      throw new ContextEngineServiceError({
        code: "RESOURCE_BINDING_INVALID",
        message: "The workstream already has a different primary resource.",
        details: { existingResourceId: existing.resource_id },
      });
    }
  }
  for (const binding of bindings) {
    const resource = readResource(database, binding.resourceId);
    if (!resource) {
      throw new ContextEngineServiceError({
        code: "RESOURCE_NOT_FOUND",
        message: "Resource does not exist.",
        details: { resourceId: binding.resourceId },
      });
    }
    if (binding.access === "mutate" && !mutationEligible(resource)) {
      throw new ContextEngineServiceError({
        code: "RESOURCE_MUTATION_UNAVAILABLE",
        message: "This resource locator cannot receive filesystem mutation authority.",
        details: { resourceId: binding.resourceId, locator: resource.locator },
      });
    }
    const existingBinding = database.prepare([
      "SELECT role, access, is_primary FROM workstream_resources",
      "WHERE workstream_id = ? AND resource_id = ?",
    ].join(" ")).get(input.workstreamId, binding.resourceId) as {
      role: ResourceRole;
      access: "read" | "mutate";
      is_primary: number;
    } | undefined;
    database.prepare([
      "INSERT INTO workstream_resources(",
      "workstream_id, resource_id, role, access, is_primary, first_bound_run_id, last_used_run_id,",
      "bound_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT(workstream_id, resource_id) DO UPDATE SET",
      "role = CASE WHEN workstream_resources.is_primary = 0 AND excluded.is_primary = 1",
      "THEN excluded.role ELSE workstream_resources.role END,",
      "access = CASE WHEN excluded.access = 'mutate' THEN 'mutate' ELSE workstream_resources.access END,",
      "is_primary = MAX(workstream_resources.is_primary, excluded.is_primary),",
      "last_used_run_id = excluded.last_used_run_id, last_used_at = excluded.last_used_at",
    ].join(" ")).run(
      input.workstreamId,
      binding.resourceId,
      binding.role,
      binding.access,
      binding.primary ? 1 : 0,
      input.runId,
      input.runId,
      input.at,
      input.at,
    );
    const canonicalBinding = database.prepare([
      "SELECT role, access, is_primary FROM workstream_resources",
      "WHERE workstream_id = ? AND resource_id = ?",
    ].join(" ")).get(input.workstreamId, binding.resourceId) as {
      role: ResourceRole;
      access: "read" | "mutate";
      is_primary: number;
    };
    for (const requestRole of binding.requestRoles) {
      database.prepare([
        "INSERT OR IGNORE INTO request_resources(",
        "workstream_id, request_id, resource_id, role, created_by_run_id, created_at",
        ") VALUES (?, ?, ?, ?, ?, ?)",
      ].join(" ")).run(
        input.workstreamId,
        input.requestId,
        binding.resourceId,
        requestRole,
        input.runId,
        input.at,
      );
      insertResourceEvent(database, {
        eventId: stableEventId(
          input.runId,
          binding.resourceId,
          "linked",
          input.workstreamId + ":" + requestRole,
        ),
        resourceId: binding.resourceId,
        workstreamId: input.workstreamId,
        requestId: input.requestId,
        runId: input.runId,
        type: "linked",
        afterVersion: resource.version,
        verification: {
          requestedRole: requestRole,
          canonicalRole: canonicalBinding.role,
          access: canonicalBinding.access,
          primary: canonicalBinding.is_primary === 1,
        },
        summary: existingBinding
          ? "Used " + resource.displayName + " in the request as " + requestRole
            + "; its canonical workstream role remains " + canonicalBinding.role + "."
          : "Linked " + resource.displayName + " to the workstream as " + canonicalBinding.role + ".",
        at: input.at,
      });
    }
    recordResourceAccess(database, binding.resourceId, input.runId, "used", input.at);
  }
  return readWorkstreamResourceBindings(database, input.workstreamId);
}

export function readWorkstreamResourceBindings(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamResourceBinding[] {
  const rows = database.prepare([
    resourceSelect("r"),
    ", wr.role, wr.access, wr.is_primary, wr.bound_at, wr.last_used_at",
    "FROM resources r JOIN workstream_resources wr ON wr.resource_id = r.resource_id",
    "WHERE wr.workstream_id = ?",
    "ORDER BY wr.is_primary DESC, wr.last_used_at DESC, r.resource_id, wr.role",
  ].join(" ")).all(workstreamId) as unknown as WorkstreamResourceRow[];
  return rows.map((row) => {
    const requestRows = database.prepare([
      "SELECT DISTINCT request_id FROM request_resources",
      "WHERE workstream_id = ? AND resource_id = ? ORDER BY request_id",
    ].join(" ")).all(workstreamId, row.resource_id) as unknown as Array<{ request_id: string }>;
    return {
      resource: resourceRef(row),
      role: row.role,
      access: row.access,
      primary: row.is_primary === 1,
      requestIds: requestRows.map((request) => request.request_id),
      boundAt: row.bound_at,
      lastUsedAt: row.last_used_at,
    };
  });
}

export function readAgentStreamResourcesProjection(
  database: ContextDatabase,
  streamId: string,
  limit = 12,
): AgentStreamResourcesProjection {
  const rows = database.prepare([
    resourceSelect("r"),
    "FROM resources r JOIN (",
    "SELECT mr.resource_id, MAX(m.created_at) AS used_at FROM message_resources mr",
    "JOIN messages m ON m.message_id = mr.message_id WHERE m.stream_id = ? GROUP BY mr.resource_id",
    ") recent ON recent.resource_id = r.resource_id",
    "ORDER BY recent.used_at DESC, r.resource_id LIMIT ?",
  ].join(" ")).all(streamId, limit) as unknown as ResourceRow[];
  const count = database.prepare([
    "SELECT COUNT(DISTINCT mr.resource_id) AS count FROM message_resources mr",
    "JOIN messages m ON m.message_id = mr.message_id WHERE m.stream_id = ?",
  ].join(" ")).get(streamId) as { count: number };
  const recent = rows.map(resourceRef);
  return {
    count: Number(count.count),
    recent,
    ...(recent[0] ? { updatedAt: recent[0].updatedAt } : {}),
  };
}

export function readRunResources(
  database: ContextDatabase,
  runId: string,
): ResourceRef[] {
  const rows = database.prepare([
    resourceSelect("r"),
    "FROM resources r JOIN (",
    "SELECT resource_id, MAX(accessed_at) AS used_at FROM resource_accesses",
    "WHERE run_id = ? GROUP BY resource_id",
    ") recent ON recent.resource_id = r.resource_id",
    "ORDER BY recent.used_at DESC, r.resource_id",
  ].join(" ")).all(runId) as unknown as ResourceRow[];
  return rows.map(resourceRef);
}

export function recordResourceObservation(
  database: ContextDatabase,
  input: {
    resourceId: string;
    runId: string;
    beforeVersion?: ResourceVersion;
    afterVersion: ResourceVersion;
    type: ResourceEvent["type"];
    verification: unknown;
    summary: string;
    at: string;
    step?: number;
    callId?: string;
    workstreamId?: string;
    requestId?: string;
  },
): ResourceEvent {
  const resource = readResource(database, input.resourceId);
  if (!resource) {
    throw new ContextEngineServiceError({
      code: "RESOURCE_NOT_FOUND",
      message: "Resource does not exist.",
      details: { resourceId: input.resourceId },
    });
  }
  const availability = input.afterVersion.exists
    ? (resource.describedVersionKey && resource.describedVersionKey !== input.afterVersion.key
        ? "changed"
        : "available")
    : input.type === "deleted" ? "deleted" : "missing";
  database.prepare([
    "UPDATE resources SET current_version_key = ?, current_version_json = ?, availability = ?,",
    "size_bytes = ?, content_hash = ?, last_verified_run_id = ?, last_verified_at = ?,",
    "updated_at = ? WHERE resource_id = ?",
  ].join(" ")).run(
    input.afterVersion.key,
    JSON.stringify(input.afterVersion),
    availability,
    input.afterVersion.sizeBytes ?? null,
    input.afterVersion.sha256 ?? null,
    input.runId,
    input.at,
    input.at,
    input.resourceId,
  );
  const event: ResourceEvent = {
    eventId: stableEventId(
      input.runId,
      input.resourceId,
      input.type,
      input.callId ?? input.afterVersion.key,
    ),
    resourceId: input.resourceId,
    ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    runId: input.runId,
    ...(input.step !== undefined ? { step: input.step } : {}),
    ...(input.callId ? { callId: input.callId } : {}),
    type: input.type,
    ...(input.beforeVersion ? { beforeVersion: input.beforeVersion } : {}),
    afterVersion: input.afterVersion,
    verification: input.verification,
    summary: input.summary,
    at: input.at,
  };
  insertResourceEvent(database, event);
  return event;
}

export function readResourceEventsForRun(
  database: ContextDatabase,
  runId: string,
): ResourceEvent[] {
  const rows = database.prepare([
    "SELECT event_id, resource_id, workstream_id, bound_request_id, run_id, step, call_id,",
    "event_type, before_version_json, after_version_json, verification_json, summary, created_at",
    "FROM resource_events WHERE run_id = ? ORDER BY created_at, event_id",
  ].join(" ")).all(runId) as unknown as Array<Record<string, unknown>>;
  return rows.map(resourceEventFromRow);
}

export function mutationEligible(resource: ResourceRef): boolean {
  return resource.locator.kind === "filesystem"
    && (resource.kind === "file" || resource.kind === "directory"
      || resource.kind === "document" || resource.kind === "image"
      || resource.kind === "audio" || resource.kind === "video"
      || resource.kind === "dataset" || resource.kind === "database"
      || resource.kind === "git_repository");
}

export function resourceLocatorKey(locator: ResourcePublicLocator): string {
  if (locator.kind === "filesystem") return "filesystem:" + resolve(locator.path);
  if (locator.kind === "managed_blob") return "managed_blob:" + locator.resourceId;
  if (locator.kind === "url") return "url:" + normalizeUrl(locator.url);
  return "external:" + locator.provider.trim().toLowerCase() + ":" + locator.externalId.trim();
}

export function resourceIdForLocator(locatorKey: string): string {
  return "RES-" + createHash("sha256").update(locatorKey).digest("hex").slice(0, 24).toUpperCase();
}

function normalizeLocator(locator: ResourcePublicLocator): ResourcePublicLocator {
  if (locator.kind === "filesystem") {
    if (!isAbsolute(locator.path)) {
      throw new ContextEngineServiceError({
        code: "RESOURCE_LOCATOR_INVALID",
        message: "Filesystem resource locators must be absolute paths.",
        details: { path: locator.path },
      });
    }
    return { kind: "filesystem", path: resolve(locator.path) };
  }
  if (locator.kind === "url") return { kind: "url", url: normalizeUrl(locator.url) };
  if (locator.kind === "managed_blob") return locator;
  return {
    kind: "external",
    provider: normalizeRequired(locator.provider, "resource provider", 200).toLowerCase(),
    externalId: normalizeRequired(locator.externalId, "external resource identity", 1_000),
    ...(locator.uri ? { uri: locator.uri.trim() } : {}),
  };
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    throw new ContextEngineServiceError({
      code: "RESOURCE_LOCATOR_INVALID",
      message: "URL resource locator is invalid.",
      details: { url: value },
    });
  }
}

function readResourceRowByLocator(
  database: ContextDatabase,
  locatorKey: string,
): ResourceRow | undefined {
  return database.prepare(resourceSelect() + " FROM resources WHERE locator_key = ?")
    .get(locatorKey) as ResourceRow | undefined;
}

function resourceSelect(alias?: string): string {
  const prefix = alias ? alias + "." : "";
  const fields = [
    "resource_id", "kind", "origin", "locator_kind", "locator_key", "locator_json",
    "display_name", "description", "aliases_json", "metadata_status", "described_version_key",
    "media_type", "size_bytes", "content_hash", "current_version_key", "current_version_json",
    "availability", "created_at", "updated_at",
  ].map((field) => prefix + field).join(", ");
  return "SELECT " + fields;
}

function resourceRef(row: ResourceRow): ResourceRef {
  return {
    resourceId: row.resource_id,
    kind: row.kind,
    origin: row.origin,
    displayName: row.display_name,
    description: row.description,
    aliases: parseStringArray(row.aliases_json, row.resource_id),
    locator: JSON.parse(row.locator_json) as ResourcePublicLocator,
    version: JSON.parse(row.current_version_json) as ResourceVersion,
    availability: row.availability,
    metadataStatus: row.metadata_status,
    ...(row.described_version_key ? { describedVersionKey: row.described_version_key } : {}),
    ...(row.media_type ? { mediaType: row.media_type } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function refreshResourceSearch(database: ContextDatabase, resourceId: string): void {
  const row = database.prepare([
    "SELECT display_name, description, aliases_json, locator_key FROM resources WHERE resource_id = ?",
  ].join(" ")).get(resourceId) as {
    display_name: string;
    description: string;
    aliases_json: string;
    locator_key: string;
  } | undefined;
  if (!row) return;
  database.prepare("DELETE FROM resource_search WHERE resource_id = ?").run(resourceId);
  database.prepare([
    "INSERT INTO resource_search(resource_id, display_name, description, aliases, locator_text)",
    "VALUES (?, ?, ?, ?, ?)",
  ].join(" ")).run(
    resourceId,
    row.display_name,
    row.description,
    parseStringArray(row.aliases_json, resourceId).join(" "),
    row.locator_key,
  );
}

function resourceSearchRecord(
  database: ContextDatabase,
  resourceId: string,
): ResourceSearchRecord | undefined {
  const resource = readResource(database, resourceId);
  if (!resource) return undefined;
  const links = database.prepare([
    "SELECT workstream_id, role, last_used_at FROM workstream_resources",
    "WHERE resource_id = ? ORDER BY last_used_at DESC",
  ].join(" ")).all(resourceId) as unknown as Array<{
    workstream_id: string;
    role: ResourceRole;
    last_used_at: string;
  }>;
  return {
    resource,
    workstreamIds: [...new Set(links.map((link) => link.workstream_id))],
    roles: [...new Set(links.map((link) => link.role))],
    ...(links[0]?.last_used_at ? { lastUsedAt: links[0].last_used_at } : {}),
  };
}

export function recordResourceAccess(
  database: ContextDatabase,
  resourceId: string,
  runId: string,
  kind: "opened" | "read" | "used" | "mutated" | "delivered",
  at: string,
): void {
  database.prepare([
    "INSERT INTO resource_accesses(resource_id, run_id, access_kind, accessed_at)",
    "VALUES (?, ?, ?, ?) ON CONFLICT(resource_id, run_id, access_kind)",
    "DO UPDATE SET accessed_at = excluded.accessed_at",
  ].join(" ")).run(resourceId, runId, kind, at);
}

function insertResourceEvent(database: ContextDatabase, event: ResourceEvent): void {
  database.prepare([
    "INSERT OR IGNORE INTO resource_events(",
    "event_id, resource_id, workstream_id, bound_request_id, run_id, step, call_id, event_type,",
    "before_version_json, after_version_json, verification_json, summary, created_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    event.eventId,
    event.resourceId,
    event.workstreamId ?? null,
    event.requestId ?? null,
    event.runId,
    event.step ?? null,
    event.callId ?? null,
    event.type,
    event.beforeVersion ? JSON.stringify(event.beforeVersion) : null,
    event.afterVersion ? JSON.stringify(event.afterVersion) : null,
    JSON.stringify(event.verification),
    event.summary,
    event.at,
  );
}

function resourceEventFromRow(row: Record<string, unknown>): ResourceEvent {
  return {
    eventId: String(row["event_id"]),
    resourceId: String(row["resource_id"]),
    ...(row["workstream_id"] ? { workstreamId: String(row["workstream_id"]) } : {}),
    ...(row["bound_request_id"] ? { requestId: String(row["bound_request_id"]) } : {}),
    runId: String(row["run_id"]),
    ...(row["step"] !== null ? { step: Number(row["step"]) } : {}),
    ...(row["call_id"] ? { callId: String(row["call_id"]) } : {}),
    type: row["event_type"] as ResourceEvent["type"],
    ...(row["before_version_json"]
      ? { beforeVersion: JSON.parse(String(row["before_version_json"])) as ResourceVersion }
      : {}),
    ...(row["after_version_json"]
      ? { afterVersion: JSON.parse(String(row["after_version_json"])) as ResourceVersion }
      : {}),
    verification: JSON.parse(String(row["verification_json"])),
    summary: String(row["summary"]),
    at: String(row["created_at"]),
  };
}

function stableEventId(runId: string, resourceId: string, type: string, discriminator: string): string {
  return "RE-" + createHash("sha256")
    .update([runId, resourceId, type, discriminator].join("\u0000"))
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
}

function availabilityFor(
  version: ResourceVersion,
  describedVersionKey: string | null,
): ResourceAvailability {
  if (!version.exists) return "missing";
  if (describedVersionKey && describedVersionKey !== version.key) return "changed";
  return "available";
}

function fallbackMetadata(
  kind: ResourceKind,
  displayName: string,
  locator: ResourcePublicLocator,
): { description: string; aliases: string[] } {
  const locatorText = locator.kind === "filesystem"
    ? locator.path
    : locator.kind === "url"
      ? locator.url
      : locator.kind === "managed_blob"
        ? locator.resourceId
        : locator.provider + ":" + locator.externalId;
  const fileName = locator.kind === "filesystem" ? basename(locator.path) : displayName;
  const stem = fileName.replace(/\.[^.]+$/, "");
  return {
    description: kind.replaceAll("_", " ") + " resource " + displayName + " at " + locatorText,
    aliases: normalizeAliases([displayName, fileName, stem]),
  };
}

function normalizeRequired(value: string, label: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    throw new ContextEngineServiceError({
      code: "RESOURCE_METADATA_INVALID",
      message: "Invalid " + label + ".",
    });
  }
  return normalized;
}

function normalizeOptional(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return normalizeRequired(value, "resource description", maximum);
}

function normalizeAliases(values: string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim().replace(/\s+/g, " "))
    .filter((value) => value.length > 0 && value.length <= 500))]
    .sort((left, right) => left.localeCompare(right));
}

function parseStringArray(value: string, resourceId: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Resource contains invalid aliases: " + resourceId);
  }
  return parsed;
}
