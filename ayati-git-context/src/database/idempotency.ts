import { createHash } from "node:crypto";
import type { ContextDatabase } from "./database.js";
import { GitContextServiceError } from "../errors.js";

interface IdempotencyRow {
  operation: string;
  request_hash: string;
  status: "in_progress" | "completed" | "recovery_required";
  response_json: string;
}

export interface RecoverableIdempotencyResult<T> {
  result: T;
  completed: boolean;
}

export function readCompletedIdempotent<T>(input: {
  database: ContextDatabase;
  requestId: string;
  operation: string;
  payload: unknown;
}): T | undefined {
  const existing = readRequest(input.database, input.requestId);
  if (!existing) {
    return undefined;
  }
  assertMatchingRequest(existing, input);
  return existing.status === "completed"
    ? JSON.parse(existing.response_json) as T
    : undefined;
}

export function executeIdempotent<T>(input: {
  database: ContextDatabase;
  requestId: string;
  operation: string;
  payload: unknown;
  now: string;
  execute: () => T;
}): T {
  return input.database.transaction(() => {
    const requestHash = hashCanonicalJson(input.payload);
    const existing = input.database.prepare([
      "SELECT operation, request_hash, status, response_json",
      "FROM idempotency_requests",
      "WHERE request_id = ?",
    ].join(" ")).get(input.requestId) as IdempotencyRow | undefined;

    if (existing) {
      if (existing.operation !== input.operation || existing.request_hash !== requestHash) {
        throw new GitContextServiceError({
          code: "IDEMPOTENCY_CONFLICT",
          message: "Request ID was already used for a different operation or payload.",
          details: {
            requestId: input.requestId,
            existingOperation: existing.operation,
            requestedOperation: input.operation,
          },
        });
      }
      return JSON.parse(existing.response_json) as T;
    }

    const result = input.execute();
    input.database.prepare([
      "INSERT INTO idempotency_requests(",
      "  request_id, operation, request_hash, status, response_json, created_at, completed_at",
      ") VALUES (?, ?, ?, 'completed', ?, ?, ?)",
    ].join(" ")).run(
      input.requestId,
      input.operation,
      requestHash,
      JSON.stringify(result),
      input.now,
      input.now,
    );
    return result;
  });
}

export function beginRecoverableIdempotent<T>(input: {
  database: ContextDatabase;
  requestId: string;
  operation: string;
  payload: unknown;
  now: string;
  execute: () => T;
}): RecoverableIdempotencyResult<T> {
  return input.database.transaction(() => {
    const requestHash = hashCanonicalJson(input.payload);
    const existing = readRequest(input.database, input.requestId);
    if (existing) {
      assertMatchingRequest(existing, input);
      return {
        result: JSON.parse(existing.response_json) as T,
        completed: existing.status === "completed",
      };
    }

    input.database.prepare([
      "INSERT INTO idempotency_requests(",
      "  request_id, operation, request_hash, status, response_json, created_at, completed_at",
      ") VALUES (?, ?, ?, 'in_progress', ?, ?, NULL)",
    ].join(" ")).run(
      input.requestId,
      input.operation,
      requestHash,
      "{}",
      input.now,
    );
    const result = input.execute();
    input.database.prepare([
      "UPDATE idempotency_requests SET response_json = ? WHERE request_id = ?",
    ].join(" ")).run(JSON.stringify(result), input.requestId);
    return { result, completed: false };
  });
}

export function hasRecoverableIdempotencyRequest(input: {
  database: ContextDatabase;
  requestId: string;
  operation: string;
  payload: unknown;
}): boolean {
  const existing = readRequest(input.database, input.requestId);
  if (!existing) return false;
  assertMatchingRequest(existing, input);
  return true;
}

export function completeRecoverableIdempotent<T>(input: {
  database: ContextDatabase;
  requestId: string;
  result: T;
  now: string;
}): T {
  input.database.transaction(() => {
    input.database.prepare([
      "UPDATE idempotency_requests",
      "SET status = 'completed', response_json = ?, completed_at = ?",
      "WHERE request_id = ?",
    ].join(" ")).run(JSON.stringify(input.result), input.now, input.requestId);
  });
  return input.result;
}

export function markRecoverableIdempotencyFailed(input: {
  database: ContextDatabase;
  requestId: string;
}): void {
  input.database.prepare([
    "UPDATE idempotency_requests SET status = 'recovery_required'",
    "WHERE request_id = ? AND status != 'completed'",
  ].join(" ")).run(input.requestId);
}

function readRequest(
  database: ContextDatabase,
  requestId: string,
): IdempotencyRow | undefined {
  return database.prepare([
    "SELECT operation, request_hash, status, response_json",
    "FROM idempotency_requests WHERE request_id = ?",
  ].join(" ")).get(requestId) as IdempotencyRow | undefined;
}

function assertMatchingRequest(
  existing: IdempotencyRow,
  input: { requestId: string; operation: string; payload: unknown },
): void {
  const requestHash = hashCanonicalJson(input.payload);
  if (existing.operation !== input.operation || existing.request_hash !== requestHash) {
    throw new GitContextServiceError({
      code: "IDEMPOTENCY_CONFLICT",
      message: "Request ID was already used for a different operation or payload.",
      details: {
        requestId: input.requestId,
        existingOperation: existing.operation,
        requestedOperation: input.operation,
      },
    });
  }
}

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]));
  return "{" + entries.join(",") + "}";
}
