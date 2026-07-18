export type FeedbackVerificationOutcome = "not_applicable" | "passed" | "failed";
export type FeedbackFinalizationOutcome =
  | "not_required"
  | "skipped"
  | "pending"
  | "started"
  | "completed"
  | "failed";
export type FeedbackCommitOutcome = "not_required" | "pending" | "committed" | "failed";

export interface FeedbackExecutionOutcome {
  verification: FeedbackVerificationOutcome;
  finalization: FeedbackFinalizationOutcome;
  commit: FeedbackCommitOutcome;
}

export interface FeedbackExecutionEvidence {
  actionSteps?: number;
  verificationPassed?: boolean;
  verificationFailed?: boolean;
  runClass?: "session" | "task";
  taskSelected?: boolean;
  finalizationStatus?: "not_started" | "started" | "committed" | "skipped" | "failed";
  committed?: boolean;
  commitIdentity?: string;
  commitCreated?: boolean;
}

export function deriveFeedbackExecutionOutcome(
  evidence: FeedbackExecutionEvidence,
): FeedbackExecutionOutcome {
  const actionSteps = validCount(evidence.actionSteps);
  const taskRun = evidence.runClass === "task" || evidence.taskSelected === true;
  const finalization = deriveFinalization(evidence.finalizationStatus, taskRun);
  return {
    verification: actionSteps === 0
      ? "not_applicable"
      : evidence.verificationFailed === true || evidence.verificationPassed !== true
        ? "failed"
        : "passed",
    finalization,
    commit: deriveCommit(evidence, taskRun, finalization),
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
  taskRun: boolean,
): FeedbackFinalizationOutcome {
  if (status === "committed") return "completed";
  if (status === "started") return "started";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "not_started" || taskRun) return "pending";
  return "not_required";
}

function deriveCommit(
  evidence: FeedbackExecutionEvidence,
  taskRun: boolean,
  finalization: FeedbackFinalizationOutcome,
): FeedbackCommitOutcome {
  const commitIdentity = nonEmptyString(evidence.commitIdentity);
  if (!taskRun) {
    if (evidence.committed === true) return commitIdentity ? "committed" : "failed";
    return finalization === "failed" ? "failed" : "not_required";
  }
  if (finalization === "failed" || finalization === "skipped") return "failed";
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
  return value === "not_required"
    || value === "skipped"
    || value === "pending"
    || value === "started"
    || value === "completed"
    || value === "failed";
}

function isCommit(value: unknown): value is FeedbackCommitOutcome {
  return value === "not_required" || value === "pending" || value === "committed" || value === "failed";
}
