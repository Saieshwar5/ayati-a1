export interface PreparedAgentRunReceipt {
  v: 1;
  kind: "prepared_agent_run";
  streamId: string;
  streamCreated: boolean;
  messageId: string;
  runId: string;
  contextRevision?: string;
}

export function completePreparedAgentRunReceipt(
  receipt: PreparedAgentRunReceipt,
  contextRevision: string,
): PreparedAgentRunReceipt {
  return { ...receipt, contextRevision };
}

export function requirePreparedAgentRunReceipt(value: unknown): PreparedAgentRunReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidReceipt();
  const receipt = value as Record<string, unknown>;
  if (receipt["v"] !== 1
    || receipt["kind"] !== "prepared_agent_run"
    || !isNonEmptyString(receipt["streamId"])
    || typeof receipt["streamCreated"] !== "boolean"
    || !isNonEmptyString(receipt["messageId"])
    || !isNonEmptyString(receipt["runId"])
    || (receipt["contextRevision"] !== undefined
      && !isNonEmptyString(receipt["contextRevision"]))) {
    throw invalidReceipt();
  }
  return receipt as unknown as PreparedAgentRunReceipt;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidReceipt(): Error {
  return new Error("Prepared agent run idempotency receipt is invalid.");
}
