import { createHash } from "node:crypto";
import type { ContextDatabase } from "./database.js";
import { GitContextServiceError } from "../errors.js";

interface IdempotencyRow {
  operation: string;
  request_hash: string;
  response_json: string;
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
      "SELECT operation, request_hash, response_json",
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
