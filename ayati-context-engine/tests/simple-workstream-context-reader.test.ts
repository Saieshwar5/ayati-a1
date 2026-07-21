import { afterEach, describe, expect, it } from "vitest";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
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
      resources: [{ role: "primary", access: "mutate", primary: true }],
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
    expect(first.context?.resources).toHaveLength(1);
  });
});
