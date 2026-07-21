import { createHash } from "node:crypto";
import type {
  RecordRunStepRequest,
  ReusableObservation,
  ReusableObservationKind,
  ReusableObservationProjection,
  ResourceId,
  RunStepToolCall,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { readResource } from "./resource-records.js";
import { readRunEvidence } from "./run-records.js";

interface ObservationRow {
  observation_id: string;
  stream_id: string;
  source_run_id: string;
  source_step: number;
  source_call_id: string | null;
  kind: ReusableObservationKind;
  query_key: string;
  purpose: string;
  preview: string;
  output_hash: string | null;
  evidence_ref: string | null;
  retention: "while_relevant" | "evidence_only";
  workstream_id: string | null;
  request_id: string | null;
  created_at: string;
}

interface ObservationResourceRow {
  resource_id: string;
  version_key: string;
}

const MAX_PER_KIND = 24;
const RESOURCE_ID_PATTERN = /^RES-[0-9A-F]{24}$/;

export function recordReusableObservations(
  database: ContextDatabase,
  input: RecordRunStepRequest,
): ReusableObservation[] {
  const run = readRunEvidence(database, input.runId);
  if (!run) throw new Error("Reusable observation source run is missing: " + input.runId);
  const inserted: ReusableObservation[] = [];
  input.record.toolCalls.forEach((call, index) => {
    const kind = observationKind(call);
    if (!kind) return;
    const sourceCallId = call.callId ?? "call-" + String(index + 1).padStart(3, "0");
    const sourceKey = [input.runId, input.record.step, sourceCallId].join(":");
    const observationId = "OBS-" + createHash("sha256")
      .update(sourceKey)
      .digest("hex")
      .slice(0, 24)
      .toUpperCase();
    const resources = resourceVersions(database, collectResourceIds([call.input, call.output]));
    const outputHash = call.outputHash ?? (call.output === undefined
      ? undefined
      : hashCanonical(call.output));
    database.prepare([
      "INSERT OR IGNORE INTO reusable_observations(",
      "observation_id, stream_id, source_run_id, source_step, source_call_id, source_key,",
      "kind, query_key, purpose, preview, output_hash, evidence_ref, retention, workstream_id,",
      "request_id, status, created_at, invalidated_at, invalidation_reason",
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, NULL, NULL)",
    ].join(" ")).run(
      observationId,
      run.streamId,
      run.runId,
      input.record.step,
      call.callId ?? null,
      sourceKey,
      kind,
      queryKey(call),
      normalizeText(call.purpose, 500),
      outputPreview(call),
      outputHash ?? null,
      "run:" + run.runId + ":step:" + input.record.step + ":call:" + sourceCallId,
      kind === "evidence" ? "evidence_only" : "while_relevant",
      run.workstreamBinding?.workstreamId ?? null,
      run.workstreamBinding?.requestId ?? null,
      input.record.createdAt,
    );
    for (const resource of resources) {
      database.prepare([
        "INSERT OR IGNORE INTO observation_resources(observation_id, resource_id, version_key)",
        "VALUES (?, ?, ?)",
      ].join(" ")).run(observationId, resource.resourceId, resource.versionKey);
    }
    const observation = readReusableObservation(database, observationId);
    if (observation) inserted.push(observation);
  });
  return inserted;
}

export function readReusableObservation(
  database: ContextDatabase,
  observationId: string,
): ReusableObservation | undefined {
  const row = database.prepare(observationSelect() + " WHERE observation_id = ?")
    .get(observationId) as ObservationRow | undefined;
  return row ? observationRecord(database, row) : undefined;
}

export function readReusableObservationProjection(
  database: ContextDatabase,
  streamId: string,
): ReusableObservationProjection {
  const rows = database.prepare([
    observationSelect(),
    "WHERE stream_id = ? AND status = 'valid'",
    "AND NOT EXISTS (",
    "SELECT 1 FROM observation_resources observed",
    "JOIN resources current ON current.resource_id = observed.resource_id",
    "WHERE observed.observation_id = reusable_observations.observation_id",
    "AND current.current_version_key != observed.version_key",
    ")",
    "ORDER BY created_at DESC, observation_id DESC",
  ].join(" ")).all(streamId) as unknown as ObservationRow[];
  const observations = rows.map((row) => observationRecord(database, row));
  const inventory = observations.filter((entry) => entry.kind === "inventory").slice(0, MAX_PER_KIND);
  const discovery = observations.filter((entry) => entry.kind === "discovery").slice(0, MAX_PER_KIND);
  const evidence = observations.filter((entry) => entry.kind === "evidence").slice(0, MAX_PER_KIND);
  return {
    revision: observationRevision([...inventory, ...discovery, ...evidence]),
    inventory,
    discovery,
    evidence,
  };
}

export function invalidateStaleReusableObservations(
  database: ContextDatabase,
  at: string,
): number {
  const result = database.prepare([
    "UPDATE reusable_observations SET status = 'invalidated', invalidated_at = ?,",
    "invalidation_reason = 'resource_version_changed'",
    "WHERE status = 'valid' AND EXISTS (",
    "SELECT 1 FROM observation_resources observed",
    "JOIN resources current ON current.resource_id = observed.resource_id",
    "WHERE observed.observation_id = reusable_observations.observation_id",
    "AND current.current_version_key != observed.version_key",
    ")",
  ].join(" ")).run(at);
  return Number(result.changes);
}

export function searchReusableObservations(database: ContextDatabase, input: {
  streamId: string;
  query: string;
  limit: number;
}): ReusableObservation[] {
  const terms = normalizedTerms(input.query);
  if (terms.length === 0) return [];
  const pattern = "%" + terms.join("%") + "%";
  const rows = database.prepare([
    observationSelect(),
    "WHERE stream_id = ? AND status = 'valid'",
    "AND NOT EXISTS (",
    "SELECT 1 FROM observation_resources observed",
    "JOIN resources current ON current.resource_id = observed.resource_id",
    "WHERE observed.observation_id = reusable_observations.observation_id",
    "AND current.current_version_key != observed.version_key",
    ")",
    "AND lower(purpose || ' ' || preview || ' ' || query_key) LIKE ?",
    "ORDER BY created_at DESC, observation_id DESC LIMIT ?",
  ].join(" ")).all(input.streamId, pattern, input.limit) as unknown as ObservationRow[];
  return rows.map((row) => observationRecord(database, row));
}

function observationRecord(
  database: ContextDatabase,
  row: ObservationRow,
): ReusableObservation {
  const resources = database.prepare([
    "SELECT resource_id, version_key FROM observation_resources",
    "WHERE observation_id = ? ORDER BY resource_id",
  ].join(" ")).all(row.observation_id) as unknown as ObservationResourceRow[];
  return {
    observationId: row.observation_id,
    streamId: row.stream_id,
    sourceRunId: row.source_run_id,
    sourceStep: Number(row.source_step),
    ...(row.source_call_id ? { sourceCallId: row.source_call_id } : {}),
    kind: row.kind,
    queryKey: row.query_key,
    purpose: row.purpose,
    preview: row.preview,
    ...(row.output_hash ? { outputHash: row.output_hash } : {}),
    ...(row.evidence_ref ? { evidenceRef: row.evidence_ref } : {}),
    retention: row.retention,
    ...(row.workstream_id ? { workstreamId: row.workstream_id } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    resources: resources.map((resource) => ({
      resourceId: resource.resource_id,
      versionKey: resource.version_key,
    })),
    createdAt: row.created_at,
  };
}

function observationSelect(): string {
  return [
    "SELECT observation_id, stream_id, source_run_id, source_step, source_call_id, kind,",
    "query_key, purpose, preview, output_hash, evidence_ref, retention, workstream_id,",
    "request_id, created_at FROM reusable_observations",
  ].join(" ");
}

function observationKind(call: RunStepToolCall): ReusableObservationKind | undefined {
  if (call.status !== "success" || call.toolEffect !== "read_only") return undefined;
  if (call.toolPurpose === "list") return "inventory";
  if (call.toolPurpose === "search") return "discovery";
  if (call.toolPurpose === "read") return "evidence";
  return undefined;
}

function queryKey(call: RunStepToolCall): string {
  const normalized = canonicalJson({ tool: call.tool, input: call.input });
  return call.tool.toLowerCase() + ":" + createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 24);
}

function outputPreview(call: RunStepToolCall): string {
  if (call.output === undefined) return normalizeText(call.purpose, 1_600);
  const rendered = typeof call.output === "string" ? call.output : canonicalJson(call.output);
  return normalizeText(rendered, 1_600);
}

function collectResourceIds(values: unknown[]): Set<ResourceId> {
  const result = new Set<ResourceId>();
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (RESOURCE_ID_PATTERN.test(value)) result.add(value);
      for (const match of value.match(/RES-[0-9A-F]{24}/g) ?? []) result.add(match);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, 1_000).forEach((entry) => visit(entry, depth + 1));
      return;
    }
    Object.values(value as Record<string, unknown>).slice(0, 1_000)
      .forEach((entry) => visit(entry, depth + 1));
  };
  values.forEach((value) => visit(value, 0));
  return result;
}

function resourceVersions(
  database: ContextDatabase,
  resourceIds: Set<ResourceId>,
): Array<{ resourceId: ResourceId; versionKey: string }> {
  return [...resourceIds].sort().flatMap((resourceId) => {
    const resource = readResource(database, resourceId);
    return resource ? [{ resourceId, versionKey: resource.version.key }] : [];
  });
}

function observationRevision(observations: ReusableObservation[]): string {
  const material = observations
    .map((entry) => [
      entry.observationId,
      entry.outputHash ?? "",
      ...entry.resources.map((resource) => resource.resourceId + "@" + resource.versionKey),
    ].join(":"))
    .sort()
    .join("\n");
  return "obs:" + createHash("sha256").update(material).digest("hex").slice(0, 24);
}

function normalizeText(value: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maximum ? normalized : normalized.slice(0, maximum - 1) + "…";
}

function normalizedTerms(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(0, 12);
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(record[key])
  ).join(",") + "}";
}
