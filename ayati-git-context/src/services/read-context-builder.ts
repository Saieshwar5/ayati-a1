import { createHash } from "node:crypto";
import type {
  ReadContextEntry,
  ReadContextProjection,
  RunClass,
  ToolCallContext,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

const REUSABLE_READ_TOOLS = new Set([
  "find_files",
  "inspect_paths",
  "list_directory",
  "read_files",
  "search_in_files",
]);

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

/**
 * Builds the verified read working set since the latest successful task commit.
 * Raw run steps remain authoritative; this projection is disposable and can be
 * reconstructed after restart.
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

  const entries = new Map<string, ReadContextEntry>();
  for (const row of rows) {
    const verification = parseJson(row.verification_json);
    if (row.tool_effect === "mutating") {
      applyMutationInvalidation(entries, row, verification);
      continue;
    }
    if (!isReusableVerifiedRead(row, verification)) continue;
    const input = parseJson(row.input_json);
    const output = parseJson(row.output_json);
    const resources = readResourcePaths(input, output, verification);
    const key = readEntryKey(row, resources, input);
    entries.set(key, {
      key,
      runId: row.run_id,
      step: Number(row.step),
      runClass: row.run_class,
      tool: row.tool,
      purpose: row.purpose,
      resources,
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(row.output_hash ? { outputHash: row.output_hash } : {}),
      verification,
      createdAt: row.created_at,
    });
  }

  const projected = [...entries.values()];
  return {
    revision: hash(JSON.stringify({
      afterTaskRunId: boundary?.run_id ?? null,
      entries: projected,
    })),
    ...(boundary ? { afterTaskRunId: boundary.run_id } : {}),
    entries: projected,
  };
}

function readTaskCommitBoundary(
  database: ContextDatabase,
  sessionId: string,
): TaskCommitBoundaryRow | undefined {
  return database.prepare([
    "SELECT r.run_id, r.run_sequence",
    "FROM task_run_finalizations f",
    "JOIN runs r ON r.run_id = f.run_id",
    "WHERE f.session_id = ? AND f.phase = 'completed'",
    "ORDER BY r.run_sequence DESC LIMIT 1",
  ].join(" ")).get(sessionId) as TaskCommitBoundaryRow | undefined;
}

function isReusableVerifiedRead(row: ReadContextStepRow, verification: unknown): boolean {
  return row.status === "completed"
    && REUSABLE_READ_TOOLS.has(row.tool)
    && verificationPassed(verification);
}

function applyMutationInvalidation(
  entries: Map<string, ReadContextEntry>,
  row: ReadContextStepRow,
  verification: unknown,
): void {
  if (row.status !== "completed" || !verificationPassed(verification)) return;
  const resources = readResourcePaths(
    parseJson(row.input_json),
    parseJson(row.output_json),
    verification,
  );
  if (resources.length === 0) {
    entries.clear();
    return;
  }
  for (const [key, entry] of entries) {
    if (entry.resources.length === 0 || resourcesOverlap(entry.resources, resources)) {
      entries.delete(key);
    }
  }
}

function readEntryKey(
  row: ReadContextStepRow,
  resources: string[],
  input: unknown,
): string {
  if (resources.length > 0) {
    return row.tool + ":" + resources.join("\0");
  }
  return row.tool + ":" + hash(JSON.stringify(input ?? null));
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
