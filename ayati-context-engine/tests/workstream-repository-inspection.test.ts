import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  materializeBoundWorkstream,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("workstream repository inspection", () => {
  it("reads bounded log, exact commit, and committed diff from only the managed repository", async () => {
    const fixture = await createWorkstreamServiceFixture("repository-inspection");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture, {
      title: "Continuation notebook",
      objective: "Preserve enough durable history to continue work safely.",
    });
    const finalized = await materializeBoundWorkstream(fixture);
    if (finalized.workstreamContextCommit.status !== "committed") {
      throw new Error("Expected the workstream finalization commit.");
    }
    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-repository-inspection-next-run",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Please continue the same work.",
      at: "2026-07-19T10:03:00+05:30",
    });
    const repositoryPath = dirname(selected.workstream.contextRepositoryPath);
    expect((await fixture.service.getAgentContext({
      streamId: fixture.prepared.stream.streamId,
    })).workstreamRepository).toMatchObject({
      path: repositoryPath,
      kind: "context_only_git",
      access: "read_only",
    });

    const log = await fixture.service.readWorkstreamRepositoryLog({
      requestId: "REQ-repository-inspection-log",
      runId: fixture.prepared.run.runId,
      repositoryPath,
      limit: 1,
      at: "2026-07-19T10:03:10+05:30",
    });

    expect(log.repository).toMatchObject({
      path: repositoryPath,
      branch: "main",
      health: "ready",
      kind: "context_only_git",
      access: "read_only",
    });
    expect(log).toMatchObject({ count: 1, hasMore: true });
    expect(log.commits[0]).toMatchObject({
      commit: finalized.workstreamContextCommit.commit,
      event: "workstream_bound_run_finalized",
      workstreamId: selected.workstream.workstreamId,
      requestId: "R-0001",
      requestStatusAfter: "active",
      outcome: "incomplete",
      stopReason: "run_limit",
      validation: "pending",
      criteria: { passed: 0, total: 0 },
      mutationCount: 0,
      next: "Continue the initial request.",
      schema: "workstream-commit/v1",
    });

    const shown = await fixture.service.readWorkstreamRepositoryCommit({
      requestId: "REQ-repository-inspection-show",
      runId: fixture.prepared.run.runId,
      repositoryPath,
      commit: log.commits[0]?.commit ?? "",
      at: "2026-07-19T10:03:20+05:30",
    });
    const workstreamDirectory = basename(selected.workstream.contextRepositoryPath);
    expect(shown.changedPaths.map((entry) => entry.path).sort()).toEqual([
      `${workstreamDirectory}/progress.md`,
      `${workstreamDirectory}/requests/R-0001-continuation-notebook.md`,
      `${workstreamDirectory}/resources.json`,
      `${workstreamDirectory}/workstream.md`,
    ]);

    const initial = shown.commit.parents[0];
    if (!initial) throw new Error("Expected the initialization parent commit.");
    const diff = await fixture.service.readWorkstreamRepositoryDiff({
      requestId: "REQ-repository-inspection-diff",
      runId: fixture.prepared.run.runId,
      repositoryPath,
      from: initial,
      to: shown.commit.commit,
      maxChars: 200,
      at: "2026-07-19T10:03:30+05:30",
    });
    expect(diff.changedPaths).toHaveLength(4);
    expect(diff.patch.length).toBeLessThanOrEqual(200);
    expect(diff.totalPatchChars).toBeGreaterThan(diff.patch.length);
    expect(diff.truncated).toBe(true);

    await expect(fixture.service.readWorkstreamRepositoryLog({
      requestId: "REQ-repository-inspection-wrong-root",
      runId: fixture.prepared.run.runId,
      repositoryPath: join(fixture.root, "workspace"),
      at: "2026-07-19T10:03:40+05:30",
    })).rejects.toMatchObject({ code: "WORKSTREAM_REPOSITORY_INVALID" });
  });
});
