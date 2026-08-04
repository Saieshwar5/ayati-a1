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

describe("bounded workstream activation context", () => {
  it("loads only the five newest progress entries for the request selected by the run", async () => {
    const fixture = await createWorkstreamServiceFixture(
      "bounded-progress",
      "Start a request that will continue across several runs.",
    );
    fixtures.push(fixture);
    const selected = await createBoundWorkstreamWithMutableDirectory(fixture, {
      title: "Long-running Project",
      objective: "Advance one bounded request across several verified runs.",
    });
    const finalizedRunIds: string[] = [];
    let head = await finalizeIncomplete(fixture, 1);
    finalizedRunIds.push(fixture.prepared.run.runId);

    for (let runNumber = 2; runNumber <= 7; runNumber += 1) {
      fixture.prepared = await fixture.service.prepareAgentRun({
        requestId: `REQ-bounded-progress-${runNumber}`,
        timezone: "Asia/Kolkata",
        agentId: "local",
        role: "user",
        content: "Continue the same unfinished project request.",
        at: at(runNumber, 0),
      });
      await fixture.service.activateWorkstreamForRun({
        requestId: `REQ-bounded-progress-${runNumber}-activate`,
        runId: fixture.prepared.run.runId,
        workstreamId: selected.workstream.workstreamId,
        expectedWorkstreamHead: head,
        route: {
          kind: "continue_current",
          requestId: "R-0001",
          reason: "The user explicitly continued the same unfinished outcome.",
        },
        at: at(runNumber, 1),
      });
      head = await finalizeIncomplete(fixture, runNumber);
      finalizedRunIds.push(fixture.prepared.run.runId);
    }

    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-bounded-progress-activate-context",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Continue the same request using its recent durable progress.",
      at: at(8, 0),
    });
    await fixture.service.activateWorkstreamForRun({
      requestId: "REQ-bounded-progress-activate-context-route",
      runId: fixture.prepared.run.runId,
      workstreamId: selected.workstream.workstreamId,
      expectedWorkstreamHead: head,
      route: {
        kind: "continue_current",
        requestId: "R-0001",
        reason: "The current run continues the same bounded request.",
      },
      at: at(8, 1),
    });

    const context = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });

    expect(context.activeWorkstream?.recentProgress).toHaveLength(5);
    expect(context.activeWorkstream?.recentProgress?.map((entry) => entry.runId))
      .toEqual(finalizedRunIds.slice(-5).reverse());
    expect(context.activeWorkstream?.recentProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "incomplete",
          validationSummary: "Overall validation was not applicable. "
            + "Completion evidence was not accepted.",
        }),
      ]),
    );
    expect(fixture.database.prepare([
      "SELECT COUNT(*) AS count FROM workstream_progress",
      "WHERE workstream_id = ? AND request_id = 'R-0001'",
    ].join(" ")).get(selected.workstream.workstreamId)).toEqual({ count: 7 });
  }, 15_000);
});

async function finalizeIncomplete(
  fixture: WorkstreamServiceFixture,
  runNumber: number,
): Promise<string> {
  const summary = `Recorded durable partial progress for run ${runNumber}.`;
  const result = await fixture.service.finalizeRun({
    requestId: `REQ-bounded-progress-${runNumber}-finalize`,
    runId: fixture.prepared.run.runId,
    outcome: "incomplete",
    stopReason: "run_limit",
    assistantResponse: summary,
    streamSummary: summary,
    summary,
    validation: "not_applicable",
    next: "Continue the same request.",
    workState: workState({
      summary,
      nextAction: "Continue the same request.",
    }),
    workstream: {
      completion: {
        accepted: false,
        resources: [],
        missing: [],
        failures: [],
        criteria: [],
      },
      requestEffect: { kind: "none" },
    },
    at: at(runNumber, 2),
  });
  if (result.workstreamContextCommit.status !== "committed") {
    throw new Error("Expected each finalized bound run to create one context commit.");
  }
  return result.workstreamContextCommit.headAfter;
}

function at(runNumber: number, second: number): string {
  return `2026-07-19T1${runNumber}:00:0${second}+05:30`;
}
