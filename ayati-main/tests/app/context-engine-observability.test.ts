import { describe, expect, it } from "vitest";
import type { ContextEngineObservabilityEvent } from "ayati-context-engine";
import { recordContextEngineObservabilityEvent } from "../../src/app/context-engine-observability.js";
import type {
  AgentFeedbackEventInput,
  AgentFeedbackLedger,
} from "../../src/ivec/feedback-ledger.js";

describe("Context Engine feedback observability bridge", () => {
  it("correlates agent-stream events through their exact message sequence", () => {
    const recorded: AgentFeedbackEventInput[] = [];
    const ledger = feedbackLedger(recorded);

    recordContextEngineObservabilityEvent(ledger, contextEngineEvent({
      contextRevision: "context:4",
      observationRevision: "observations:4",
    }));

    expect(recorded).toEqual([expect.objectContaining({
      sessionId: "AST-1",
      seq: 4,
      stage: "context_engine",
      event: "run_step_persisted",
      data: expect.objectContaining({
        streamId: "AST-1",
        contextRevision: "context:4",
        observationRevision: "observations:4",
      }),
    })]);
  });

  it("does not synthesize a sequence when the service event omits one", () => {
    const recorded: AgentFeedbackEventInput[] = [];

    const event = contextEngineEvent({});
    delete event.seq;
    recordContextEngineObservabilityEvent(feedbackLedger(recorded), event);

    expect(recorded[0]?.seq).toBeUndefined();
  });
});

function feedbackLedger(recorded: AgentFeedbackEventInput[]): AgentFeedbackLedger {
  return {
    enabled: true,
    record: (event) => recorded.push(event),
    flush: async () => await Promise.resolve(),
    close: async () => await Promise.resolve(),
  };
}

function contextEngineEvent(data: Record<string, unknown>): ContextEngineObservabilityEvent {
  return {
    v: 1,
    ts: "2026-07-18T10:00:00.000Z",
    tsMs: 1,
    pid: 123,
    level: "info",
    component: "context-engine",
    event: "run_step_persisted",
    streamId: "AST-1",
    seq: 4,
    runId: "RUN-1",
    outcome: "succeeded",
    data,
  };
}
