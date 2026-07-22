import { describe, expect, it } from "vitest";
import type { EvaluationEvent } from "../../src/evaluation/contracts.js";
import { buildDeterministicFindings } from "../../src/evaluation/diagnostics.js";

describe("unified evaluation Context Engine diagnostics", () => {
  it("accepts a complete binding and durable matching finalization", () => {
    const findings = buildDeterministicFindings({
      runId: "RUN-1",
      events: [
        event("run_workstream_bound", {
          workstreamBinding: { workstreamId: "W-1", requestId: "R-1" },
        }),
        event("run_finalization_started", { outcome: "done" }),
        event("run_finalization_completed", {
          workstreamContextCommit: {
            status: "committed",
            commit: "a".repeat(40),
            headAfter: "a".repeat(40),
          },
        }),
      ],
      operations: [],
      requests: [],
      captureDegraded: false,
    });
    expect(findings.map((item) => item.code)).not.toContain("ROUTING_BINDING_INCOMPLETE");
    expect(findings.map((item) => item.code)).not.toContain("FINALIZATION_ACKNOWLEDGEMENT_MISSING");
    expect(findings.map((item) => item.code)).not.toContain("CONTEXT_COMMIT_IDENTITY_INCONSISTENT");
  });

  it("reports incomplete routing and inconsistent durable finalization", () => {
    const findings = buildDeterministicFindings({
      runId: "RUN-1",
      events: [
        event("run_workstream_bound", {}),
        event("run_finalization_started", { outcome: "done" }),
        event("run_finalization_completed", {
          workstreamContextCommit: {
            status: "committed",
            commit: "a".repeat(40),
            headAfter: "b".repeat(40),
          },
        }),
        event("run_finalization_started", { outcome: "done" }),
      ],
      operations: [],
      requests: [],
      captureDegraded: false,
    });
    expect(findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "ROUTING_BINDING_INCOMPLETE",
      "FINALIZATION_ACKNOWLEDGEMENT_MISSING",
      "CONTEXT_COMMIT_IDENTITY_INCONSISTENT",
    ]));
  });
});

function event(name: string, data: Record<string, unknown>) {
  const record: EvaluationEvent = {
    schemaVersion: 1,
    eventId: `EVT-${name}-${Math.random()}`,
    evaluationId: "eval-1",
    timestamp: new Date().toISOString(),
    timestampMs: Date.now(),
    monotonicNs: "1",
    component: "context_engine",
    event: name,
    runId: "RUN-1",
    attribution: "foreground",
    outcome: "completed",
    artifacts: [],
  };
  return { record, data };
}
