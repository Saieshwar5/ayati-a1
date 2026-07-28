import { afterEach, describe, expect, it } from "vitest";
import { readRecentWorkstreams } from "../src/repositories/recent-workstream-records.js";
import {
  createWorkstreamServiceFixture,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("recent workstream records", () => {
  it("returns at most ten distinct metadata-only workstreams by latest creation or use", async () => {
    const fixture = await createFixture("recent-workstream-metadata");
    for (let index = 1; index <= 12; index++) {
      insertWorkstream(fixture, index, `2026-07-${String(index).padStart(2, "0")}T10:00:00.000Z`);
    }
    fixture.database.prepare([
      "INSERT INTO workstream_accesses(workstream_id, run_id, access_kind, accessed_at)",
      "VALUES (?, ?, 'opened', ?)",
    ].join(" ")).run(
      "W-20260701-0001",
      fixture.prepared.run.runId,
      "2026-07-24T10:00:00.000Z",
    );

    const recent = readRecentWorkstreams(fixture.database);

    expect(recent).toHaveLength(10);
    expect(recent[0]).toEqual({
      workstreamId: "W-20260701-0001",
      title: "Workstream 1",
      lifecycleStatus: "active",
      repositoryHealth: "ready",
      currentRequest: {
        id: "R-0001",
        title: "Request 1",
        status: "active",
      },
      lastActivity: {
        kind: "opened",
        at: "2026-07-24T10:00:00.000Z",
      },
    });
    expect(recent.map((workstream) => workstream.workstreamId)).toEqual([
      "W-20260701-0001",
      "W-20260712-0001",
      "W-20260711-0001",
      "W-20260710-0001",
      "W-20260709-0001",
      "W-20260708-0001",
      "W-20260707-0001",
      "W-20260706-0001",
      "W-20260705-0001",
      "W-20260704-0001",
    ]);
    expect(JSON.stringify(recent)).not.toContain("objective");
    expect(JSON.stringify(recent)).not.toContain("repositoryPath");
    expect(JSON.stringify(recent)).not.toContain("head");

    const projected = await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    });
    expect(projected.stream?.recentWorkstreams).toEqual(recent);
  });

  it("uses the latest access deterministically and excludes incomplete catalog entries", async () => {
    const fixture = await createFixture("recent-workstream-state");
    insertWorkstream(fixture, 1, "2026-07-20T10:00:00.000Z");
    insertWorkstream(fixture, 2, "2026-07-21T10:00:00.000Z", "initializing", null);
    insertWorkstream(fixture, 3, "2026-07-22T10:00:00.000Z", "recovery_required");
    fixture.database.prepare([
      "INSERT INTO workstream_accesses(workstream_id, run_id, access_kind, accessed_at)",
      "VALUES (?, ?, ?, ?)",
    ].join(" ")).run(
      "W-20260701-0001",
      fixture.prepared.run.runId,
      "opened",
      "2026-07-23T10:00:00.000Z",
    );
    fixture.database.prepare([
      "INSERT INTO workstream_accesses(workstream_id, run_id, access_kind, accessed_at)",
      "VALUES (?, ?, ?, ?)",
    ].join(" ")).run(
      "W-20260701-0001",
      fixture.prepared.run.runId,
      "bound",
      "2026-07-24T10:00:00.000Z",
    );

    expect(readRecentWorkstreams(fixture.database)).toEqual([
      expect.objectContaining({
        workstreamId: "W-20260701-0001",
        lastActivity: {
          kind: "bound",
          at: "2026-07-24T10:00:00.000Z",
        },
      }),
    ]);
  });
});

async function createFixture(name: string): Promise<WorkstreamServiceFixture> {
  const fixture = await createWorkstreamServiceFixture(name);
  fixtures.push(fixture);
  return fixture;
}

function insertWorkstream(
  fixture: WorkstreamServiceFixture,
  index: number,
  createdAt: string,
  status: "initializing" | "active" | "archived" | "recovery_required" = "active",
  head: string | null = String(index).repeat(40).slice(0, 40),
): void {
  const date = String(index).padStart(2, "0");
  const workstreamId = `W-202607${date}-0001`;
  fixture.database.prepare([
    "INSERT INTO workstreams(",
    "workstream_id, directory_path, title, aliases_json, purpose, lifecycle_status,",
    "current_request_id, current_snapshot, current_focus, blockers_json, last_commit_sha,",
    "last_activity_at, status, created_at, updated_at",
    ") VALUES (?, ?, ?, '[]', ?, 'active', NULL, ?, ?, '[]', ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    workstreamId,
    `${fixture.root}/workstreams/W-202607${date}-0001`,
    `Workstream ${index}`,
    `Objective ${index}`,
    `Snapshot ${index}`,
    `Focus ${index}`,
    head,
    createdAt,
    status,
    createdAt,
    createdAt,
  );
  fixture.database.prepare([
    "INSERT INTO workstream_requests(",
    "workstream_id, request_id, relative_path, title, status, source, request_text,",
    "acceptance_json, constraints_json, contract_hash, lifecycle_note, outcome_summary,",
    "created_at, updated_at, started_at, closed_at, last_activity_at",
    ") VALUES (?, 'R-0001', 'requests/R-0001-request.md', ?, 'active', 'user', ?,",
    "'[\"The request is verified.\"]', '[]', ?, 'Created as active.', 'Pending.',",
    "?, ?, ?, NULL, ?)",
  ].join(" ")).run(
    workstreamId,
    `Request ${index}`,
    `Complete request ${index}.`,
    `hash-${index}`,
    createdAt,
    createdAt,
    createdAt,
    createdAt,
  );
  fixture.database.prepare(
    "UPDATE workstreams SET current_request_id = 'R-0001' WHERE workstream_id = ?",
  ).run(workstreamId);
}
