export interface PreparedContextTurnReceipt {
  v: 1;
  kind: "prepared_context_turn";
  sessionId: string;
  sessionCreated: boolean;
  conversationId: string;
  messageId: string;
  contextRevision?: string;
}

export function createPreparedContextTurnReceipt(input: {
  sessionId: string;
  sessionCreated: boolean;
  conversationId: string;
  messageId: string;
}): PreparedContextTurnReceipt {
  return {
    v: 1,
    kind: "prepared_context_turn",
    ...input,
  };
}

export function completePreparedContextTurnReceipt(
  receipt: PreparedContextTurnReceipt,
  contextRevision: string,
): PreparedContextTurnReceipt {
  return { ...receipt, contextRevision };
}

export function requirePreparedContextTurnReceipt(value: unknown): PreparedContextTurnReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidReceipt();
  }
  const receipt = value as Record<string, unknown>;
  if (receipt["v"] !== 1
    || receipt["kind"] !== "prepared_context_turn"
    || !isNonEmptyString(receipt["sessionId"])
    || typeof receipt["sessionCreated"] !== "boolean"
    || !isNonEmptyString(receipt["conversationId"])
    || !isNonEmptyString(receipt["messageId"])
    || (receipt["contextRevision"] !== undefined
      && !isNonEmptyString(receipt["contextRevision"]))) {
    throw invalidReceipt();
  }
  return receipt as unknown as PreparedContextTurnReceipt;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidReceipt(): Error {
  return new Error("Prepared context turn idempotency receipt is invalid.");
}
