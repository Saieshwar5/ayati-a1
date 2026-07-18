import type { ConversationPersistenceState } from "../contracts.js";

export interface ConversationMaterializationEvidence {
  status: "pending" | "completed" | "failed";
  targetPath: string;
  contentHash?: string;
}

export interface ConversationPersistenceEvidence {
  plannedPath?: string;
  contentHash?: string;
  committedSha?: string;
  materialization?: ConversationMaterializationEvidence;
}

export function deriveConversationPersistenceState(
  evidence: ConversationPersistenceEvidence,
): ConversationPersistenceState {
  const plannedPath = nonEmpty(evidence.plannedPath);
  const committedSha = nonEmpty(evidence.committedSha);
  const materialization = evidence.materialization;
  const operationPath = nonEmpty(materialization?.targetPath);
  const operationContentHash = nonEmpty(materialization?.contentHash);
  const hasCompletedEvidence = materialization?.status === "completed"
    && Boolean(operationPath && operationContentHash);
  const contentHash = hasCompletedEvidence
    ? operationContentHash
    : nonEmpty(evidence.contentHash);
  const materializationState = deriveMaterializationState(
    Boolean(committedSha),
    materialization?.status,
    hasCompletedEvidence,
  );
  const isMaterialized = materializationState === "materialized";
  const materializedPath = hasCompletedEvidence ? operationPath : plannedPath;

  return {
    database: "saved",
    materialization: materializationState,
    git: committedSha ? "committed" : "not_committed",
    ...(plannedPath ? { plannedPath } : {}),
    ...(isMaterialized && materializedPath
      ? { materializedPath }
      : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(committedSha ? { committedSha } : {}),
  };
}

function deriveMaterializationState(
  committed: boolean,
  operationStatus: ConversationMaterializationEvidence["status"] | undefined,
  hasCompletedEvidence: boolean,
): ConversationPersistenceState["materialization"] {
  if (committed) return "materialized";
  if (operationStatus === "completed") {
    return hasCompletedEvidence ? "materialized" : "failed";
  }
  return operationStatus ?? "not_requested";
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
