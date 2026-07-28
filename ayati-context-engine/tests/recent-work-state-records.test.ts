import { afterEach, describe, expect, it } from "vitest";
import type {
  RunOutcome,
  RunStopReason,
  RunWorkStateInput,
} from "../src/contracts.js";
import {
  MAX_RECENT_WORK_STATE_HANDOFFS,
  readRecentWorkStateHandoffs,
} from "../src/repositories/recent-work-state-records.js";
import {
  boundRequestAcceptance,
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("recent WorkState records", () => {
  it("keeps useful historical handoffs, excludes trivial runs, and projects binding metadata", async () => {
    const fixture = await createFixture("recent-work-state-filter");
    const streamId = fixture.prepared.stream.streamId;
    await finalizeCurrent(fixture, {
      response: "Hello!",
      state: workState({
        status: "done",
        summary: "Answered a greeting.",
      }),
      at: "2026-07-26T08:00:01.000Z",
      suffix: "trivial",
    });

    await prepareNext(
      fixture,
      "REQ-recent-work-state-useful",
      "Read the report and preserve the important result.",
      "2026-07-26T08:01:00.000Z",
    );
    const usefulRunId = fixture.prepared.run.runId;
    await finalizeCurrent(fixture, {
      response: "The report was read.",
      state: workState({
        status: "done",
        summary: "Read the report and captured its validated result.",
        importantContext: [{
          kind: "finding",
          value: "The report requires a nine-day watering interval.",
          ref: `run:${usefulRunId}:step:1:call:read-report`,
        }],
      }),
      at: "2026-07-26T08:01:01.000Z",
      suffix: "useful",
    });

    await prepareNext(
      fixture,
      "REQ-recent-work-state-bound",
      "Implement the recent WorkState Hot Context source.",
      "2026-07-26T08:02:00.000Z",
    );
    const boundRunId = fixture.prepared.run.runId;
    const selected = await createBoundWorkstream(fixture, {
      title: "Recent WorkState Hot Context",
      objective: "Make useful historical WorkState handoffs loadable on demand.",
    });
    fixture.prepared = {
      ...fixture.prepared,
      run: selected.run,
    };
    await finalizeCurrent(fixture, {
      response: "The Hot Context source was implemented.",
      state: workState({
        status: "done",
        summary: "Implemented the recent WorkState Hot Context source.",
        plan: [{
          id: "source",
          task: "Implement the WorkState Hot Context source.",
          status: "done",
        }],
      }),
      at: "2026-07-26T08:02:01.000Z",
      suffix: "bound",
    });

    await prepareNext(
      fixture,
      "REQ-recent-work-state-current",
      "Continue the recent context work.",
      "2026-07-26T08:03:00.000Z",
    );
    const recent = readRecentWorkStateHandoffs(fixture.database, { streamId });

    expect(recent.map((handoff) => handoff.runId)).toEqual([
      boundRunId,
      usefulRunId,
    ]);
    expect(recent[0]).toMatchObject({
      runId: boundRunId,
      sourceRef: `run:${boundRunId}`,
      requestSeq: 5,
      responseSeq: 6,
      runStatus: "done",
      stopReason: "completed",
      workState: {
        status: "done",
        summary: "Implemented the recent WorkState Hot Context source.",
        updateReason: "run_completed",
      },
      workstream: {
        workstreamId: selected.run.workstreamBinding?.workstreamId,
        title: "Recent WorkState Hot Context",
        requestId: selected.run.workstreamBinding?.requestId,
      },
    });
    expect(recent[1]).toMatchObject({
      runId: usefulRunId,
      sourceRef: `run:${usefulRunId}`,
      requestSeq: 3,
      responseSeq: 4,
      workState: {
        importantContext: [{
          kind: "finding",
          value: "The report requires a nine-day watering interval.",
        }],
      },
    });
    expect(fixture.prepared.context.stream?.recentWorkStates).toEqual(recent);
  });

  it("orders newest first and caps the projection at five material runs", async () => {
    const fixture = await createFixture("recent-work-state-limit");
    const streamId = fixture.prepared.stream.streamId;
    const completedRunIds: string[] = [];

    for (let index = 0; index < MAX_RECENT_WORK_STATE_HANDOFFS + 2; index++) {
      if (index > 0) {
        await prepareNext(
          fixture,
          `REQ-recent-work-state-limit-${index}`,
          `Complete material task ${index + 1}.`,
          timestamp(index, 0),
        );
      }
      const runId = fixture.prepared.run.runId;
      completedRunIds.push(runId);
      await finalizeCurrent(fixture, {
        response: `Completed material task ${index + 1}.`,
        state: workState({
          status: "done",
          summary: `Completed material task ${index + 1}.`,
          importantContext: [{
            kind: "finding",
            value: `Material result ${index + 1}.`,
            ref: `run:${runId}`,
          }],
        }),
        at: timestamp(index, 1),
        suffix: `limit-${index}`,
      });
    }

    const recent = readRecentWorkStateHandoffs(fixture.database, { streamId });

    expect(recent).toHaveLength(MAX_RECENT_WORK_STATE_HANDOFFS);
    expect(recent.map((handoff) => handoff.runId)).toEqual(
      completedRunIds.slice(-MAX_RECENT_WORK_STATE_HANDOFFS).reverse(),
    );
    expect(new Set(recent.map((handoff) => handoff.runId)).size)
      .toBe(MAX_RECENT_WORK_STATE_HANDOFFS);
    const projected = await fixture.service.getAgentContext({ streamId });
    expect(projected.stream?.recentWorkStates).toEqual(recent);
  });
});

async function createFixture(name: string): Promise<WorkstreamServiceFixture> {
  const fixture = await createWorkstreamServiceFixture(name, "Say hello.");
  fixtures.push(fixture);
  return fixture;
}

async function prepareNext(
  fixture: WorkstreamServiceFixture,
  requestId: string,
  content: string,
  at: string,
): Promise<void> {
  fixture.prepared = await fixture.service.prepareAgentRun({
    requestId,
    timezone: "Asia/Kolkata",
    agentId: "local",
    scopeKey: "default",
    role: "user",
    content,
    at,
  });
}

async function finalizeCurrent(
  fixture: WorkstreamServiceFixture,
  input: {
    response: string;
    state: RunWorkStateInput;
    at: string;
    suffix: string;
    outcome?: RunOutcome;
    stopReason?: RunStopReason;
  },
): Promise<void> {
  await fixture.service.finalizeRun({
    requestId: `REQ-recent-work-state-${input.suffix}-finalize`,
    runId: fixture.prepared.run.runId,
    outcome: input.outcome ?? "done",
    stopReason: input.stopReason ?? "completed",
    assistantResponse: input.response,
    streamSummary: input.state.summary,
    summary: input.state.summary,
    validation: input.outcome && input.outcome !== "done" ? "failed" : "passed",
    workState: input.state,
    workstream: fixture.prepared.run.workstreamBinding
      ? {
          completion: {
            accepted: true,
            resources: [],
            missing: [],
            failures: [],
            criteria: boundRequestAcceptance(fixture).map((criterion) => ({
              criterion,
              passed: true,
              evidence: "The implementation handoff was recorded.",
            })),
          },
          requestEffect: input.outcome && input.outcome !== "done"
            ? { kind: "none" }
            : { kind: "complete", verification: "verified" },
        }
      : undefined,
    at: input.at,
  });
}

function timestamp(index: number, offsetSeconds: number): string {
  return `2026-07-26T09:${String(index).padStart(2, "0")}:${String(offsetSeconds).padStart(2, "0")}.000Z`;
}
