import {
  ContextEngineObserver,
  type ContextEngineObservabilityEvent,
} from "ayati-context-engine";
import type { AgentFeedbackLedger } from "../ivec/feedback-ledger.js";

/** Bridges Context Engine events into the live-test feedback ledger. */
export function recordContextEngineObservabilityEvent(
  ledger: AgentFeedbackLedger,
  event: ContextEngineObservabilityEvent,
): void {
  const seq = feedbackSequence(event);
  ledger.record({
    ...(event.streamId ? { sessionId: event.streamId } : {}),
    ...(seq !== undefined ? { seq } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    stage: "context_engine",
    event: event.event,
    data: {
      component: event.component,
      level: event.level,
      pid: event.pid,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.requestId ? { requestId: event.requestId } : {}),
      ...(event.clientId ? { clientId: event.clientId } : {}),
      ...(event.streamId ? { streamId: event.streamId } : {}),
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

function feedbackSequence(event: ContextEngineObservabilityEvent): number | undefined {
  return event.seq;
}

export function createHarnessContextEngineObserver(
  ledger: AgentFeedbackLedger,
): ContextEngineObserver {
  return new ContextEngineObserver(
    "context-engine-harness",
    (event) => recordContextEngineObservabilityEvent(ledger, event),
  );
}
