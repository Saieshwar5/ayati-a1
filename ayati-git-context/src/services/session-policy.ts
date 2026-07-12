import type { EnsureActiveSessionRequest, SessionRef } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";

export function validateSessionInput(input: EnsureActiveSessionRequest): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Session date must use YYYY-MM-DD format.",
    });
  }
  if (normalizeAgentId(input.agentId).length === 0) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Agent ID must contain a letter or number.",
    });
  }
}

export function normalizeAgentId(agentId: string): string {
  return agentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function verifyExpectedHead(
  session: SessionRef,
  expectedHead: string | undefined,
): void {
  if (expectedHead === undefined) return;
  if (session.head !== expectedHead) {
    throw new GitContextServiceError({
      code: "SESSION_HEAD_MISMATCH",
      message: "Session HEAD does not match the caller expectation.",
      retryable: true,
      details: {
        sessionId: session.sessionId,
        expectedHead,
        actualHead: session.head,
      },
    });
  }
}
