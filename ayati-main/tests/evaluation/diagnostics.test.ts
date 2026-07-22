import { describe, expect, it } from "vitest";
import type { EvaluationEvent } from "../../src/evaluation/contracts.js";
import {
  buildDeterministicFindings,
  type HydratedEvaluationEvent,
} from "../../src/evaluation/diagnostics.js";

describe("live evaluation navigation diagnostics", () => {
  it("accepts one model-free deterministic binding attempt", () => {
    const findings = findingsFor([
      event("EVT-1", "deterministic_binding_started"),
      event("EVT-2", "deterministic_binding_resolved"),
    ]);

    expect(findings.map((finding) => finding.code)).not.toContain("MULTIPLE_RESOLVE_GATE_ATTEMPTS");
    expect(findings.map((finding) => finding.code)).not.toContain("RESOLVE_GATE_USED_MODEL_CONTEXT");
  });

  it("flags repeated binding attempts and model-attributed gate events", () => {
    const second = event("EVT-2", "deterministic_binding_started");
    second.record.operationId = "OP-RESOLVER";
    second.record.requestId = "REQ-RESOLVER";
    const findings = findingsFor([
      event("EVT-1", "deterministic_binding_started"),
      second,
    ]);

    expect(findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "MULTIPLE_RESOLVE_GATE_ATTEMPTS",
      "RESOLVE_GATE_USED_MODEL_CONTEXT",
    ]));
  });
});

function findingsFor(events: HydratedEvaluationEvent[]) {
  return buildDeterministicFindings({
    runId: "RUN-1",
    events,
    operations: [],
    requests: [],
    captureDegraded: false,
  });
}

function event(eventId: string, name: string): HydratedEvaluationEvent {
  const record: EvaluationEvent = {
    schemaVersion: 1,
    eventId,
    evaluationId: "EVAL-1",
    timestamp: "2026-07-22T10:00:00.000Z",
    timestampMs: 1,
    monotonicNs: "1",
    component: "workstream_binding",
    event: name,
    runId: "RUN-1",
    attribution: "foreground",
    outcome: "completed",
    artifacts: [],
  };
  return { record };
}
