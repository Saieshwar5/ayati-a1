import {
  GitContextObserver,
  type GitContextObservabilityEvent,
} from "ayati-git-context";
import type { AgentFeedbackLedger } from "../ivec/feedback-ledger.js";

/** Bridges transport-neutral Git Context events into the live-test feedback ledger. */
export function recordGitContextObservabilityEvent(
  ledger: AgentFeedbackLedger,
  event: GitContextObservabilityEvent,
): void {
  ledger.record({
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.seq !== undefined ? { seq: event.seq } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    stage: event.component === "git-context-harness" ? "context_engine" : "git_context_service",
    event: event.event,
    data: {
      component: event.component,
      level: event.level,
      pid: event.pid,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.requestId ? { requestId: event.requestId } : {}),
      ...(event.clientId ? { clientId: event.clientId } : {}),
      ...(event.conversationId ? { conversationId: event.conversationId } : {}),
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.step !== undefined ? { step: event.step } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      ...(event.message ? { message: event.message } : {}),
      ...event.data,
    },
  });
}

export function createHarnessGitContextObserver(
  ledger: AgentFeedbackLedger,
): GitContextObserver {
  return new GitContextObserver(
    "git-context-harness",
    (event) => recordGitContextObservabilityEvent(ledger, event),
  );
}
