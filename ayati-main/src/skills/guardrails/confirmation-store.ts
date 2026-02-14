import { randomUUID } from "node:crypto";
import { getConfirmationGuardrailsPolicy } from "../tool-access-config.js";
import type { ToolResult } from "../types.js";

interface PendingConfirmation {
  fingerprint: string;
  expiresAt: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

function now(): number {
  return Date.now();
}

function purgeExpired(): void {
  const current = now();
  for (const [id, item] of pendingConfirmations.entries()) {
    if (item.expiresAt <= current) pendingConfirmations.delete(id);
  }
}

export function requestConfirmation(fingerprint: string, meta: Record<string, unknown>): ToolResult {
  const policy = getConfirmationGuardrailsPolicy();
  const operationId = randomUUID();
  const expiresAt = now() + policy.ttlMs;
  pendingConfirmations.set(operationId, { fingerprint, expiresAt });

  return {
    ok: false,
    error: "confirmation required",
    meta: {
      ...meta,
      requiresConfirmation: true,
      operationId,
      confirmationTokenFormat: `${policy.tokenPrefix}<operation_id>`,
      expiresAt,
    },
  };
}

export function verifyConfirmationToken(
  token: string | undefined,
  fingerprint: string,
): ToolResult | null {
  const policy = getConfirmationGuardrailsPolicy();
  if (!policy.enabled) return null;
  if (!token || token.trim().length === 0) return null;

  purgeExpired();

  if (!token.startsWith(policy.tokenPrefix)) {
    return {
      ok: false,
      error: `Invalid confirmation token format. Expected ${policy.tokenPrefix}<operation_id>.`,
    };
  }

  const operationId = token.slice(policy.tokenPrefix.length).trim();
  if (operationId.length === 0) {
    return {
      ok: false,
      error: `Invalid confirmation token format. Expected ${policy.tokenPrefix}<operation_id>.`,
    };
  }

  const pending = pendingConfirmations.get(operationId);
  if (!pending) {
    return { ok: false, error: "Confirmation token is expired, unknown, or already used." };
  }

  if (pending.expiresAt <= now()) {
    pendingConfirmations.delete(operationId);
    return { ok: false, error: "Confirmation token has expired." };
  }

  if (pending.fingerprint !== fingerprint) {
    return { ok: false, error: "Confirmation token does not match this operation." };
  }

  pendingConfirmations.delete(operationId);
  return null;
}

export function clearPendingConfirmationsForTests(): void {
  pendingConfirmations.clear();
}
