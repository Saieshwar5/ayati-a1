import type { ConversationPersistenceState } from "ayati-git-context";

export type FeedbackConversationPersistenceState = ConversationPersistenceState;

export function readFeedbackConversationPersistenceState(
  value: unknown,
): FeedbackConversationPersistenceState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["database"] !== "saved"
    || !isMaterializationState(record["materialization"])
    || !isGitState(record["git"])) {
    return undefined;
  }

  const plannedPath = nonEmptyString(record["plannedPath"]);
  const materializedPath = nonEmptyString(record["materializedPath"]);
  const contentHash = nonEmptyString(record["contentHash"]);
  const committedSha = nonEmptyString(record["committedSha"]);
  if (record["git"] === "committed" && !committedSha) return undefined;
  if (record["git"] === "not_committed" && committedSha) return undefined;
  if (record["materialization"] !== "materialized" && materializedPath) return undefined;
  if (record["git"] === "committed" && record["materialization"] !== "materialized") {
    return undefined;
  }

  return {
    database: "saved",
    materialization: record["materialization"],
    git: record["git"],
    ...(plannedPath ? { plannedPath } : {}),
    ...(materializedPath ? { materializedPath } : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(committedSha ? { committedSha } : {}),
  };
}

function isMaterializationState(
  value: unknown,
): value is FeedbackConversationPersistenceState["materialization"] {
  return value === "not_requested"
    || value === "pending"
    || value === "materialized"
    || value === "failed";
}

function isGitState(value: unknown): value is FeedbackConversationPersistenceState["git"] {
  return value === "not_committed" || value === "committed";
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
