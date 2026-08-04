import { afterEach, describe, expect, it } from "vitest";
import {
  createBoundWorkstream,
  createBoundWorkstreamWithMutableDirectory,
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("workstream context reading", () => {
  it("returns concise durable context plus authoritative resource bindings", async () => {
    const fixture = await createWorkstreamServiceFixture("read-context");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture, {
      title: "Learn TypeScript",
      objective: "Develop TypeScript skill through durable daily practice.",
    });

    const result = await fixture.service.getWorkstream({
      workstreamId: selected.workstream.workstreamId,
    });

    expect(result.context).toMatchObject({
      title: "Learn TypeScript",
      objective: "Develop TypeScript skill through durable daily practice.",
      summary: "The workstream is initialized; no request work is complete yet.",
      currentRequest: { id: "R-0001", status: "active" },
      resources: [],
    });
    expect(result.context).not.toHaveProperty("importantPaths");
    expect(result.context).not.toHaveProperty("workingDirectory");
  });

  it("records an idempotent open without binding or switching another workstream", async () => {
    const fixture = await createWorkstreamServiceFixture("read-open");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture);
    const input = {
      requestId: "REQ-open-workstream",
      runId: fixture.prepared.run.runId,
      workstreamId: selected.workstream.workstreamId,
      at: "2026-07-19T10:02:00+05:30",
    };

    const first = await fixture.service.readWorkstream(input);
    const replayed = await fixture.service.readWorkstream(input);

    expect(replayed).toEqual(first);
    expect(first.opened).toBe(true);
    expect(fixture.database.prepare([
      "SELECT COUNT(*) AS count FROM workstream_accesses",
      "WHERE workstream_id = ? AND run_id = ? AND access_kind = 'opened'",
    ].join(" ")).get(selected.workstream.workstreamId, fixture.prepared.run.runId))
      .toEqual({ count: 1 });
    expect(first.context?.resources).toEqual([]);
  });

  it("opens one completed request and its bounded recent progress without reopening it", async () => {
    const fixture = await createWorkstreamServiceFixture("read-completed-request");
    fixtures.push(fixture);
    const selected = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Historical Request Notebook",
      objective: "Keep completed request context available for later questions.",
      initialRequest: {
        title: "Capture comet launch decision",
        request: "Capture the verified comet launch decision.",
        acceptance: ["The comet launch decision is verified."],
        constraints: ["Preserve the original decision."],
      },
    });
    await fixture.service.finalizeRun({
      requestId: "REQ-complete-comet-request",
      runId: fixture.prepared.run.runId,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "The comet launch decision is recorded.",
      streamSummary: "Completed the bounded decision request.",
      summary: "The comet launch decision was verified and recorded.",
      validation: "passed",
      workState: workState({
        status: "done",
        summary: "The comet launch decision was verified and recorded.",
      }),
      workstream: {
        completion: {
          accepted: true,
          resources: [],
          missing: [],
          failures: [],
          criteria: [{
            criterion: "The comet launch decision is verified.",
            passed: true,
            evidence: "Deterministic decision validation passed.",
          }],
        },
        requestEffect: { kind: "complete", verification: "verified" },
      },
      at: "2026-07-19T10:03:00+05:30",
    });
    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-read-completed-prepare",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "What was the comet launch decision?",
      at: "2026-07-19T10:04:00+05:30",
    });

    const opened = await fixture.service.readWorkstream({
      requestId: "REQ-read-completed",
      runId: fixture.prepared.run.runId,
      workstreamId: selected.workstream.workstreamId,
      workstreamRequestId: "R-0001",
      at: "2026-07-19T10:05:00+05:30",
    });

    expect(opened.context).toMatchObject({
      selectedRequest: {
        id: "R-0001",
        status: "done",
        finalOutcome: "The comet launch decision was verified and recorded.",
      },
      recentProgress: [{
        outcome: "done",
        summary: "The comet launch decision was verified and recorded.",
      }],
    });
    expect(opened.context).not.toHaveProperty("currentRequest");
    expect(fixture.database.prepare([
      "SELECT workstream_id, bound_request_id FROM runs WHERE run_id = ?",
    ].join(" ")).get(fixture.prepared.run.runId)).toEqual({
      workstream_id: null,
      bound_request_id: null,
    });
    expect(fixture.database.prepare([
      "SELECT status FROM workstream_requests",
      "WHERE workstream_id = ? AND request_id = 'R-0001'",
    ].join(" ")).get(selected.workstream.workstreamId)).toEqual({ status: "done" });
  });
});
