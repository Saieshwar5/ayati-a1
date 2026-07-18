import type { FeedbackTaskLifecycle } from "./git-context-feedback-model.js";

export interface GitContextFeedbackTriageFinding {
  code: string;
  severity: "info" | "warning" | "error";
  title: string;
  details: string;
  recommendation: string;
}

export function buildGitContextLifecycleFindings(input: {
  lifecycle?: FeedbackTaskLifecycle;
  pendingTurnStatus?: string;
  runClass?: "session" | "task";
}): GitContextFeedbackTriageFinding[] {
  const findings: GitContextFeedbackTriageFinding[] = [];
  const repository = input.lifecycle?.repository;
  const request = input.lifecycle?.request;
  const run = input.lifecycle?.run;
  const finalization = input.lifecycle?.finalization;

  if (repository) {
    if (repository.selectionMode && !repository.workingDirectory) {
      findings.push(finding(
        "v1_working_directory_missing",
        "error",
        "V1 working directory is missing",
        "The selected V1 task did not expose its canonical stable working directory.",
        "Preserve workingDirectory from the selected task response through routing feedback.",
      ));
    }
    if (repository.selectionMode === "activated"
      && request?.decision !== "continue"
      && request?.decision !== "create") {
      findings.push(finding(
        "v1_request_decision_missing",
        "error",
        "V1 request decision is missing",
        "An existing task was activated without feedback proving an explicit continue-or-create decision.",
        "Carry requestDecision and the resolved task request id through the routing result and summary.",
      ));
    }
    if (repository.selectionMode && !request?.requestId) {
      findings.push(finding(
        "v1_task_request_missing",
        "error",
        "Selected task request is missing",
        "The task run has no observable resolved task request identity.",
        "Inspect task-request route planning before mutation authority is acquired.",
      ));
    }
    if ((request?.decision === "initial" || request?.decision === "create")
      && request.created !== true) {
      findings.push(finding(
        "v1_request_creation_mismatch",
        "error",
        "Request creation did not match the decision",
        `The '${request.decision}' decision resolved without creating its request.`,
        "Inspect request route planning and idempotent replay state.",
      ));
    }
    if (request?.decision === "continue" && request.created !== false) {
      findings.push(finding(
        "v1_request_continue_created_request",
        "error",
        "Continue decision created a request",
        "The explicit continue decision unexpectedly allocated a new task request.",
        "Verify the exact active request id and request-route reducer.",
      ));
    }
    if (finalization?.status === "committed") {
      if (finalization.commitCreated === undefined) {
        findings.push(finding(
          "v1_commit_creation_missing",
          "error",
          "Commit result is missing",
          "Completed finalization did not say whether it created a task commit.",
          "Preserve taskCommitCreated from the finalization response.",
        ));
      }
      if (!finalization.headAfter) {
        findings.push(finding(
          "v1_final_head_missing",
          "error",
          "Final HEAD is missing",
          "Completed finalization did not expose the task HEAD after reduction.",
          "Preserve taskHeadAfter from the finalization response.",
        ));
      }
      if (finalization.commitCreated === true && !finalization.commit) {
        findings.push(finding(
          "v1_commit_identity_missing",
          "error",
          "Commit identity is missing",
          "Finalization reported a new task commit without exposing its identity.",
          "Preserve finalization response identity in the feedback event.",
        ));
      } else if (finalization.commit && finalization.headAfter
        && finalization.commit !== finalization.headAfter) {
        findings.push(finding(
          "v1_commit_head_mismatch",
          "error",
          "Commit and HEAD disagree",
          "The reported final task commit is not the reported task HEAD after finalization.",
          "Inspect finalization acknowledgement and repository validation before reporting success.",
        ));
      }
    }
    if (finalization?.validation === "failed") {
      findings.push(finding(
        "v1_finalization_validation_failed",
        "warning",
        "Task finalization validation failed",
        "The task lifecycle completed, but its requested validation did not pass.",
        "Inspect the verified facts and finalization outcome before treating the user goal as complete.",
      ));
    }
    if (finalization?.outcome && finalization.outcome !== "done") {
      findings.push(finding(
        `v1_task_outcome_${finalization.outcome}`,
        "warning",
        `Task outcome is ${finalization.outcome.replaceAll("_", " ")}`,
        `The repository lifecycle is consistent, but the task run ended with outcome '${finalization.outcome}'.`,
        "Use the task card, request state, and final reply to decide whether to continue or request user input.",
      ));
    }
  }

  if (input.pendingTurnStatus === "clarifying"
    && (input.runClass === "task" || run?.selectedAs === "task")) {
    findings.push(finding(
      "clarification_with_task_run",
      "warning",
      "Clarification owns a task run",
      "A clarification may have a session run, but it should not bind mutation work to a task before ownership is clear.",
      "Inspect the explicit routing result and keep clarification session-only.",
    ));
  }

  if (input.pendingTurnStatus === "unbound" && run?.selectedAs === "task") {
    findings.push(finding(
      "unbound_turn_has_task_binding",
      "error",
      "Unbound turn has task authority",
      "The turn remained unbound while feedback reported a selected task run.",
      "Fix routing state propagation before exposing normal task tools.",
    ));
  }

  return findings;
}

function finding(
  code: string,
  severity: "warning" | "error",
  title: string,
  details: string,
  recommendation: string,
): GitContextFeedbackTriageFinding {
  return { code, severity, title, details, recommendation };
}
