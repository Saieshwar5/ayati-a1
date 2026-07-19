import type { FeedbackWorkstreamLifecycle } from "./git-context-feedback-model.js";

export interface GitContextFeedbackTriageFinding {
  code: string;
  severity: "info" | "warning" | "error";
  title: string;
  details: string;
  recommendation: string;
}

export function buildGitContextLifecycleFindings(input: {
  lifecycle?: FeedbackWorkstreamLifecycle;
  pendingTurnStatus?: string;
  workstreamBound?: boolean;
}): GitContextFeedbackTriageFinding[] {
  const findings: GitContextFeedbackTriageFinding[] = [];
  const repository = input.lifecycle?.repository;
  const request = input.lifecycle?.request;
  const run = input.lifecycle?.run;
  const finalization = input.lifecycle?.finalization;

  if (repository) {
    if (repository.selectionMode && !repository.contextRepositoryPath) {
      findings.push(finding(
        "workstream_context_repository_missing",
        "error",
        "Workstream context repository is missing",
        "The selected workstream did not expose its context-only repository path.",
        "Preserve contextRepositoryPath from the selected workstream response through routing feedback.",
      ));
    }
    if (repository.selectionMode === "activated"
      && request?.decision !== "continue"
      && request?.decision !== "create") {
      findings.push(finding(
        "workstream_request_decision_missing",
        "error",
        "workstream request decision is missing",
        "An existing workstream was activated without feedback proving an explicit continue-or-create decision.",
        "Carry requestDecision and the resolved workstream request id through the routing result and summary.",
      ));
    }
    if (repository.selectionMode && !request?.requestId) {
      findings.push(finding(
        "workstream_request_missing",
        "error",
        "Selected workstream request is missing",
        "The workstream-bound run has no observable resolved workstream request identity.",
        "Inspect workstream-request route planning before mutation authority is acquired.",
      ));
    }
    if ((request?.decision === "initial" || request?.decision === "create")
      && request.created !== true) {
      findings.push(finding(
        "workstream_request_creation_mismatch",
        "error",
        "Request creation did not match the decision",
        `The '${request.decision}' decision resolved without creating its request.`,
        "Inspect request route planning and idempotent replay state.",
      ));
    }
    if (request?.decision === "continue" && request.created !== false) {
      findings.push(finding(
        "workstream_request_continue_created_request",
        "error",
        "Continue decision created a request",
        "The explicit continue decision unexpectedly allocated a new workstream request.",
        "Verify the exact active request id and request-route reducer.",
      ));
    }
    if (finalization?.status === "committed") {
      if (finalization.commitCreated === undefined) {
        findings.push(finding(
          "workstream_commit_creation_missing",
          "error",
          "Commit result is missing",
          "Completed finalization did not say whether it created a workstream commit.",
          "Preserve workstreamCommitCreated from the finalization response.",
        ));
      }
      if (!finalization.headAfter) {
        findings.push(finding(
          "workstream_final_head_missing",
          "error",
          "Final HEAD is missing",
          "Completed finalization did not expose the workstream HEAD after reduction.",
          "Preserve workstreamHeadAfter from the finalization response.",
        ));
      }
      if (finalization.commitCreated === true && !finalization.commit) {
        findings.push(finding(
          "workstream_commit_identity_missing",
          "error",
          "Commit identity is missing",
          "Finalization reported a new workstream commit without exposing its identity.",
          "Preserve finalization response identity in the feedback event.",
        ));
      } else if (finalization.commit && finalization.headAfter
        && finalization.commit !== finalization.headAfter) {
        findings.push(finding(
          "workstream_commit_head_mismatch",
          "error",
          "Commit and HEAD disagree",
          "The reported final workstream commit is not the reported workstream HEAD after finalization.",
          "Inspect finalization acknowledgement and repository validation before reporting success.",
        ));
      }
    }
    if (finalization?.validation === "failed") {
      findings.push(finding(
        "workstream_finalization_validation_failed",
        "warning",
        "Workstream finalization validation failed",
        "The workstream lifecycle completed, but its requested validation did not pass.",
        "Inspect the verified facts and finalization outcome before treating the user goal as complete.",
      ));
    }
    if (finalization?.outcome && finalization.outcome !== "done") {
      findings.push(finding(
        `workstream_outcome_${finalization.outcome}`,
        "warning",
        `Workstream outcome is ${finalization.outcome.replaceAll("_", " ")}`,
        `The repository lifecycle is consistent, but the workstream-bound run ended with outcome '${finalization.outcome}'.`,
        "Use the workstream card, request state, and final reply to decide whether to continue or request user input.",
      ));
    }
  }

  if (input.pendingTurnStatus === "clarifying"
    && (input.workstreamBound === true || run?.workstreamBound === true)) {
    findings.push(finding(
      "clarification_with_workstream_binding",
      "warning",
      "Clarification owns a workstream binding",
      "The clarification run bound mutation work to a workstream before ownership was clear.",
      "Inspect the explicit routing result and keep the clarification run unbound.",
    ));
  }

  if (input.pendingTurnStatus === "unbound" && (input.workstreamBound === true || run?.workstreamBound === true)) {
    findings.push(finding(
      "unbound_turn_has_workstream_binding",
      "error",
      "Unbound turn has workstream authority",
      "The run remained unbound while feedback reported a workstream binding.",
      "Fix routing state propagation before exposing normal workstream tools.",
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
