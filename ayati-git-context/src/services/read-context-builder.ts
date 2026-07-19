import { createHash } from "node:crypto";
import type {
  ReadContextEntry,
  ReadContextProjection,
  RunClass,
  ToolCallContext,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

type ContextBucket = "inventory" | "discovery" | "evidence" | "actions";

const CONTEXT_BUCKET_BY_TOOL: Readonly<Record<string, ContextBucket>> = {
  list_directory: "inventory",
  find_files: "discovery",
  search_in_files: "discovery",
  inspect_paths: "evidence",
  read_files: "evidence",
  create_directory: "actions",
  patch_files: "actions",
  write_files: "actions",
};

interface TaskCommitBoundaryRow {
  run_id: string;
  run_sequence: number;
}

interface ReadContextStepRow {
  run_id: string;
  run_class: RunClass;
  run_sequence: number;
  step: number;
  tool: string;
  tool_effect: ToolCallContext["toolEffect"];
  purpose: string;
  status: ToolCallContext["status"];
  input_json: string | null;
  output_json: string | null;
  output_hash: string | null;
  verification_json: string | null;
  created_at: string;
}

interface StepToolCall {
  callId?: string;
  tool: string;
  purpose: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  outputHash?: string;
}

type ContextBucketMaps = Record<ContextBucket, Map<string, ReadContextEntry>>;

/**
 * Builds reusable context since the latest successful task commit. Raw run
 * steps remain authoritative; this projection is disposable and reconstructs
 * deterministically after restart.
 */
export function buildReadContext(
  database: ContextDatabase,
  sessionId: string,
): ReadContextProjection {
  const boundary = readTaskCommitBoundary(database, sessionId);
  const rows = database.prepare([
    "SELECT r.run_id, r.run_class, r.run_sequence, rs.step, rs.tool, rs.tool_effect,",
    "rs.purpose, rs.status, rs.input_json, rs.output_json, rs.output_hash,",
    "rs.verification_json, rs.created_at",
    "FROM run_steps rs",
    "JOIN runs r ON r.run_id = rs.run_id",
    "WHERE r.session_id = ? AND r.run_sequence > ?",
    "ORDER BY r.run_sequence, rs.step",
  ].join(" ")).all(sessionId, boundary?.run_sequence ?? 0) as unknown as ReadContextStepRow[];

  const buckets = createBucketMaps();
  for (const row of rows) {
    const verification = parseJson(row.verification_json);
    if (row.status !== "completed" || !verificationPassed(verification)) continue;

    const calls = readStepToolCalls(row);
    for (const call of calls) {
      if (call.error !== undefined && call.error !== null) continue;
      const bucket = CONTEXT_BUCKET_BY_TOOL[call.tool];
      if (bucket === "actions") {
        const resources = readResourcePaths(call.input, call.output, verification);
        invalidateObservedContext(buckets, resources);
        setContextEntry(buckets.actions, bucket, row, call, resources, verification);
        continue;
      }
      if (bucket) {
        const resources = readResourcePaths(call.input, call.output, verification);
        setContextEntry(buckets[bucket], bucket, row, call, resources, verification);
        continue;
      }
      if (row.tool_effect === "mutating") {
        invalidateObservedContext(
          buckets,
          readResourcePaths(call.input, call.output, verification),
        );
      }
    }
  }

  const projected = {
    inventory: [...buckets.inventory.values()],
    discovery: [...buckets.discovery.values()],
    evidence: [...buckets.evidence.values()],
    actions: [...buckets.actions.values()],
  };
  return {
    revision: hash(JSON.stringify({
      afterTaskRunId: boundary?.run_id ?? null,
      ...projected,
    })),
    ...(boundary ? { afterTaskRunId: boundary.run_id } : {}),
    ...projected,
  };
}

function createBucketMaps(): ContextBucketMaps {
  return {
    inventory: new Map(),
    discovery: new Map(),
    evidence: new Map(),
    actions: new Map(),
  };
}

function readTaskCommitBoundary(
  database: ContextDatabase,
  sessionId: string,
): TaskCommitBoundaryRow | undefined {
  return database.prepare([
    "SELECT r.run_id, r.run_sequence",
    "FROM runs r",
    "WHERE r.session_id = ? AND EXISTS (SELECT 1 FROM simple_task_finalizations f",
    "  WHERE f.run_id = r.run_id AND f.phase = 'completed' AND f.commit_created = 1)",
    "ORDER BY r.run_sequence DESC LIMIT 1",
  ].join(" ")).get(sessionId) as TaskCommitBoundaryRow | undefined;
}

function readStepToolCalls(row: ReadContextStepRow): StepToolCall[] {
  const input = parseJson(row.input_json);
  const output = parseJson(row.output_json);
  if (!isRecord(input) || !Array.isArray(input["toolCalls"])) {
    return [{
      tool: row.tool,
      purpose: row.purpose,
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(row.output_hash ? { outputHash: row.output_hash } : {}),
    }];
  }

  const outputCalls = isRecord(output) && Array.isArray(output["toolCalls"])
    ? output["toolCalls"]
    : [];
  return input["toolCalls"].flatMap((value, index): StepToolCall[] => {
    if (!isRecord(value) || typeof value["tool"] !== "string") return [];
    const callId = typeof value["callId"] === "string" ? value["callId"] : undefined;
    const matchingOutput = outputCalls.find((candidate) => (
      isRecord(candidate)
      && callId !== undefined
      && candidate["callId"] === callId
    )) ?? outputCalls[index];
    const outputRecord = isRecord(matchingOutput) ? matchingOutput : undefined;
    const callOutput = outputRecord?.["output"];
    return [{
      ...(callId ? { callId } : {}),
      tool: value["tool"],
      purpose: typeof value["purpose"] === "string" ? value["purpose"] : row.purpose,
      ...(value["input"] !== undefined ? { input: value["input"] } : {}),
      ...(callOutput !== undefined ? { output: callOutput } : {}),
      ...(outputRecord?.["error"] !== undefined ? { error: outputRecord["error"] } : {}),
      ...(callOutput !== undefined ? { outputHash: hash(JSON.stringify(callOutput)) } : {}),
    }];
  });
}

function setContextEntry(
  entries: Map<string, ReadContextEntry>,
  bucket: ContextBucket,
  row: ReadContextStepRow,
  call: StepToolCall,
  resources: string[],
  verification: unknown,
): void {
  const key = readEntryKey(bucket, call.tool, resources, call.input);
  entries.set(key, {
    key,
    runId: row.run_id,
    step: Number(row.step),
    ...(call.callId ? { callId: call.callId } : {}),
    runClass: row.run_class,
    tool: call.tool,
    purpose: call.purpose,
    resources,
    ...(call.input !== undefined ? { input: call.input } : {}),
    ...(call.output !== undefined ? { output: call.output } : {}),
    ...(call.outputHash ? { outputHash: call.outputHash } : {}),
    verification,
    createdAt: row.created_at,
  });
}

function invalidateObservedContext(
  buckets: ContextBucketMaps,
  resources: string[],
): void {
  for (const bucket of [buckets.inventory, buckets.discovery, buckets.evidence]) {
    if (resources.length === 0) {
      bucket.clear();
      continue;
    }
    for (const [key, entry] of bucket) {
      if (entry.resources.length === 0 || resourcesOverlap(entry.resources, resources)) {
        bucket.delete(key);
      }
    }
  }
}

function readEntryKey(
  bucket: ContextBucket,
  tool: string,
  resources: string[],
  input: unknown,
): string {
  if (resources.length > 0) {
    return bucket + ":" + tool + ":" + resources.join("\0");
  }
  return bucket + ":" + tool + ":" + hash(JSON.stringify(input ?? null));
}

function readResourcePaths(...values: unknown[]): string[] {
  const paths = new Set<string>();
  for (const value of values) collectResourcePaths(value, undefined, paths);
  return [...paths].sort();
}

function collectResourcePaths(
  value: unknown,
  parentKey: string | undefined,
  paths: Set<string>,
): void {
  if (typeof value === "string") {
    if (isPathKey(parentKey) || parentKey === "artifacts" || parentKey === "paths") {
      const normalized = normalizePath(value);
      if (normalized) paths.add(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResourcePaths(item, parentKey, paths);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    collectResourcePaths(item, key, paths);
  }
}

function isPathKey(key: string | undefined): boolean {
  return key === "path"
    || key === "filePath"
    || key === "requestedPath"
    || key === "resolvedPath"
    || key === "root"
    || key === "workdir";
}

function normalizePath(value: string): string | undefined {
  const trimmed = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

function resourcesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => (
    leftPath === rightPath
    || leftPath.startsWith(rightPath + "/")
    || rightPath.startsWith(leftPath + "/")
  )));
}

function verificationPassed(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value["passed"] === true
    || value["status"] === "passed"
    || value["validationStatus"] === "passed";
}

function parseJson(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
