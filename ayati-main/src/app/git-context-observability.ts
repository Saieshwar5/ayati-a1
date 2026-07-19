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
  const seq = feedbackSequence(event);
  ledger.record({
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(seq !== undefined ? { seq } : {}),
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
      ...(event.workstreamId ? { workstreamId: event.workstreamId } : {}),
      ...(event.step !== undefined ? { step: event.step } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      ...(event.message ? { message: event.message } : {}),
      ...event.data,
    },
  });
}

function feedbackSequence(event: GitContextObservabilityEvent): number | undefined {
  if (event.seq !== undefined) return event.seq;
  if (event.event !== "conversation_persisted") return undefined;
  const sequence = event.data?.["conversationSequence"];
  return typeof sequence === "number" && Number.isInteger(sequence) && sequence > 0
    ? sequence
    : undefined;
}

export function createHarnessGitContextObserver(
  ledger: AgentFeedbackLedger,
): GitContextObserver {
  return new GitContextObserver(
    "git-context-harness",
    (event) => recordGitContextObservabilityEvent(ledger, event),
  );
}
