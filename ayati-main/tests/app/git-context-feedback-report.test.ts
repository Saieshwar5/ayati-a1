import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const reportScript = fileURLToPath(
  new URL("../../../scripts/git-context-feedback-report.mjs", import.meta.url),
);
let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ayati-feedback-report-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("git-context-feedback-report", () => {
  it("renders a healthy workstream lifecycle", async () => {
    const input = join(tempDir, "session.jsonl");
    const commit = "b".repeat(40);
    await writeFile(input, [
      JSON.stringify({
        ts: "2026-07-18T10:00:00.000Z",
        tsMs: 1,
        stage: "git_context_service",
        event: "run_workstream_bound",
        runId: "RUN-1",
        workstreamId: "W-20260718-0001",
        data: {
          mode: "created",
          contextRepositoryPath: "/ayati/workstreams/W-20260718-0001-site",
          workstreamCreated: true,
          requestDecision: "initial",
          requestId: "R-0001",
          requestStatus: "active",
          requestCreated: true,
        },
      }),
      JSON.stringify({
        ts: "2026-07-18T10:00:01.000Z",
        tsMs: 2,
        stage: "git_context_service",
        event: "run_finalization_started",
        runId: "RUN-1",
        workstreamId: "W-20260718-0001",
        data: {
          workstreamBinding: {
            workstreamId: "W-20260718-0001",
            requestId: "R-0001",
          },
          contextRepositoryPath: "/ayati/workstreams/W-20260718-0001-site",
          requestedOutcome: "done",
          validation: "passed",
        },
      }),
      JSON.stringify({
        ts: "2026-07-18T10:00:02.000Z",
        tsMs: 3,
        stage: "git_context_service",
        event: "run_finalization_completed",
        runId: "RUN-1",
        workstreamId: "W-20260718-0001",
        data: {
          outcome: "done",
          workstreamBinding: {
            workstreamId: "W-20260718-0001",
            requestId: "R-0001",
          },
          contextRepositoryPath: "/ayati/workstreams/W-20260718-0001-site",
          workstreamContextCommit: {
            status: "committed",
            workstreamId: "W-20260718-0001",
            requestId: "R-0001",
            headBefore: "a".repeat(40),
            headAfter: commit,
            commit,
          },
        },
      }),
      "",
    ].join("\n"), "utf8");

    const result = spawnSync(process.execPath, [reportScript, "--input", input], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("PASS — no deterministic lifecycle or outcome findings.");
    expect(result.stdout).toContain("Workstream selections: 1");
    expect(result.stdout).toContain("Workstream-bound runs: 1");
    expect(result.stdout).toContain("initial | R-0001 (active)");
    expect(result.stdout).toContain("committed (done, passed)");
  });

  it("reports incomplete workstream selection data", async () => {
    const input = join(tempDir, "invalid.jsonl");
    await writeFile(input, `${JSON.stringify({
      ts: "2026-07-18T10:00:00.000Z",
      tsMs: 1,
      stage: "git_context_service",
      event: "run_workstream_bound",
      runId: "RUN-1",
      workstreamId: "W-20260718-0001",
      data: {},
    })}\n`, "utf8");

    const result = spawnSync(process.execPath, [reportScript, "--input", input], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FAIL — 3 lifecycle/outcome finding(s).");
    expect(result.stdout).toContain("no context repository");
    expect(result.stdout).toContain("no explicit request decision");
    expect(result.stdout).toContain("no request identity");
  });
});
