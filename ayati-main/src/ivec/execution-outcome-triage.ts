import type { FeedbackExecutionOutcome } from "./execution-outcome-feedback.js";

export interface FeedbackExecutionTriageFinding {
  code: string;
  severity: "info" | "warning" | "error";
  title: string;
  details: string;
  recommendation: string;
}

export interface FeedbackExecutionTriageInput {
  execution?: FeedbackExecutionOutcome;
  actionSteps?: number;
  taskBound: boolean;
  commitIdentity?: string;
}

export function buildExecutionOutcomeFindings(
  input: FeedbackExecutionTriageInput,
): FeedbackExecutionTriageFinding[] {
  const execution = input.execution;
  if (!execution) return [];
  const findings: FeedbackExecutionTriageFinding[] = [];
  const actionSteps = validCount(input.actionSteps);

  if (actionSteps > 0 && execution.verification === "not_applicable") {
    findings.push(finding(
      "execution_verification_missing",
      "error",
      "Executable work has no verification outcome",
      "The summary marked verification not applicable even though action steps executed.",
      "Derive verification from deterministic action-step results before finalizing feedback.",
    ));
  }
  if (actionSteps === 0 && execution.verification === "passed") {
    findings.push(finding(
      "execution_verification_without_action",
      "warning",
      "Verification passed without executable work",
      "The summary claims successful verification even though no action step executed.",
      "Use not_applicable for tool-free conversation and control-only turns.",
    ));
  }
  if (input.taskBound
    && (execution.finalization === "pending" || execution.finalization === "started")
    && execution.commit !== "pending") {
    findings.push(finding(
      "task_commit_state_mismatch",
      "error",
      "Task commit state contradicts finalization",
      "Task finalization is incomplete but the commit outcome is not pending.",
      "Derive task commit state from the same finalization journal and commit acknowledgement.",
    ));
  }
  if (execution.commit === "committed" && !nonEmpty(input.commitIdentity)) {
    findings.push(finding(
      "commit_identity_missing",
      "error",
      "Committed outcome has no commit identity",
      "The compact outcome claims a commit without a corresponding commit SHA.",
      "Preserve final commit identity through finalization and feedback projection.",
    ));
  }
  if (!input.taskBound && execution.commit === "committed") {
    findings.push(finding(
      "unexpected_conversation_commit",
      "error",
      "Conversation-only turn created a task commit",
      "Feedback reports a committed execution even though the run had no task binding.",
      "Keep direct conversations commit-free or report the missing task binding.",
    ));
  }
  if (execution.finalization === "failed" && execution.commit !== "failed") {
    findings.push(finding(
      "failed_finalization_commit_mismatch",
      "error",
      "Failed finalization has a non-failed commit outcome",
      "The finalization and commit outcomes disagree about the failed terminal state.",
      "Reduce both outcomes from the same finalization failure event.",
    ));
  }
  if (input.taskBound
    && execution.finalization === "completed"
    && execution.verification === "failed") {
    findings.push(finding(
      "finalized_after_failed_verification",
      "warning",
      "Task finalized after failed verification",
      "The task reached completed finalization even though deterministic verification failed.",
      "Inspect whether the finalization outcome should have been failed or blocked.",
    ));
  }

  return findings;
}

export function isHealthyConversationOutcome(input: FeedbackExecutionTriageInput): boolean {
  const actionSteps = validCount(input.actionSteps);
  return input.taskBound === false
    && (actionSteps === 0
      ? input.execution?.verification === "not_applicable"
      : input.execution?.verification === "passed")
    && input.execution?.finalization === "completed"
    && input.execution.commit === "not_required";
}

function finding(
  code: string,
  severity: FeedbackExecutionTriageFinding["severity"],
  title: string,
  details: string,
  recommendation: string,
): FeedbackExecutionTriageFinding {
  return { code, severity, title, details, recommendation };
}

function validCount(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
