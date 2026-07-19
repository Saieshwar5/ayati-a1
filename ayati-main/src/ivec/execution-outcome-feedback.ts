export type FeedbackVerificationOutcome = "not_applicable" | "passed" | "failed";
export type FeedbackFinalizationOutcome =
  | "pending"
  | "started"
  | "completed"
  | "failed";
export type FeedbackCommitOutcome = "not_required" | "no_change" | "pending" | "committed" | "failed";

export interface FeedbackExecutionOutcome {
  verification: FeedbackVerificationOutcome;
  finalization: FeedbackFinalizationOutcome;
  commit: FeedbackCommitOutcome;
}

export interface FeedbackExecutionEvidence {
  actionSteps?: number;
  verificationPassed?: boolean;
  verificationFailed?: boolean;
  taskBound?: boolean;
  finalizationStatus?: "not_started" | "started" | "not_required" | "no_change" | "committed" | "failed";
  commitStatus?: "not_required" | "no_change" | "committed";
  committed?: boolean;
  commitIdentity?: string;
  commitCreated?: boolean;
}

export function deriveFeedbackExecutionOutcome(
  evidence: FeedbackExecutionEvidence,
): FeedbackExecutionOutcome {
  const actionSteps = validCount(evidence.actionSteps);
  const finalization = deriveFinalization(evidence.finalizationStatus);
  return {
    verification: actionSteps === 0
      ? "not_applicable"
      : evidence.verificationFailed === true || evidence.verificationPassed !== true
        ? "failed"
        : "passed",
    finalization,
    commit: deriveCommit(evidence, evidence.taskBound === true, finalization),
  };
}

export function readFeedbackExecutionOutcome(
  value: unknown,
): FeedbackExecutionOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isVerification(record["verification"])
    || !isFinalization(record["finalization"])
    || !isCommit(record["commit"])) {
    return undefined;
  }
  return {
    verification: record["verification"],
    finalization: record["finalization"],
    commit: record["commit"],
  };
}

function deriveFinalization(
  status: FeedbackExecutionEvidence["finalizationStatus"],
): FeedbackFinalizationOutcome {
  if (status === "committed" || status === "no_change" || status === "not_required") return "completed";
  if (status === "started") return "started";
  if (status === "failed") return "failed";
  return "pending";
}

function deriveCommit(
  evidence: FeedbackExecutionEvidence,
  taskRun: boolean,
  finalization: FeedbackFinalizationOutcome,
): FeedbackCommitOutcome {
  const commitIdentity = nonEmptyString(evidence.commitIdentity);
  if (evidence.commitStatus === "not_required") return "not_required";
  if (evidence.commitStatus === "no_change") return "no_change";
  if (evidence.commitStatus === "committed") {
    return commitIdentity ? "committed" : "failed";
  }
  if (!taskRun) {
    if (evidence.committed === true) return commitIdentity ? "committed" : "failed";
    return finalization === "failed" ? "failed" : "not_required";
  }
  if (finalization === "failed") return "failed";
  if (finalization === "completed") {
    if (evidence.commitCreated === false) return "not_required";
    return evidence.committed === true && commitIdentity ? "committed" : "failed";
  }
  return "pending";
}

function validCount(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isVerification(value: unknown): value is FeedbackVerificationOutcome {
  return value === "not_applicable" || value === "passed" || value === "failed";
}

function isFinalization(value: unknown): value is FeedbackFinalizationOutcome {
  return value === "pending"
    || value === "started"
    || value === "completed"
    || value === "failed";
}

function isCommit(value: unknown): value is FeedbackCommitOutcome {
  return value === "not_required" || value === "no_change" || value === "pending" || value === "committed" || value === "failed";
}
