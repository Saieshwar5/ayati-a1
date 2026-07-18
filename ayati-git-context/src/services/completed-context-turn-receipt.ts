export interface CompletedContextTurnReceipt {
  v: 1;
  kind: "completed_context_turn";
  sessionId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  contextRevision?: string;
  pendingDigest?: string;
}

export function createCompletedContextTurnReceipt(input: {
  sessionId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}): CompletedContextTurnReceipt {
  return {
    v: 1,
    kind: "completed_context_turn",
    ...input,
  };
}

export function completeContextTurnReceipt(
  receipt: CompletedContextTurnReceipt,
  projection: { contextRevision: string; pendingDigest: string },
): CompletedContextTurnReceipt {
  return { ...receipt, ...projection };
}

export function requireCompletedContextTurnReceipt(value: unknown): CompletedContextTurnReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidReceipt();
  }
  const receipt = value as Record<string, unknown>;
  if (receipt["v"] !== 1
    || receipt["kind"] !== "completed_context_turn"
    || !isNonEmptyString(receipt["sessionId"])
    || !isNonEmptyString(receipt["conversationId"])
    || !isNonEmptyString(receipt["userMessageId"])
    || !isNonEmptyString(receipt["assistantMessageId"])
    || (receipt["contextRevision"] !== undefined
      && !isNonEmptyString(receipt["contextRevision"]))
    || (receipt["pendingDigest"] !== undefined
      && !isNonEmptyString(receipt["pendingDigest"]))) {
    throw invalidReceipt();
  }
  return receipt as unknown as CompletedContextTurnReceipt;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidReceipt(): Error {
  return new Error("Completed context turn idempotency receipt is invalid.");
}
