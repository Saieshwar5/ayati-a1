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
  it("renders a healthy task lifecycle", async () => {
    const input = join(tempDir, "session.jsonl");
    const commit = "b".repeat(40);
    await writeFile(input, [
      JSON.stringify({
        ts: "2026-07-18T10:00:00.000Z",
        tsMs: 1,
        stage: "git_context_service",
        event: "session_run_bound",
        runId: "RUN-1",
        taskId: "T-20260718-0001",
        data: {
          mode: "created",
          workingDirectory: "/tasks/T-20260718-0001-site",
          taskCreated: true,
          taskRequestDecision: "initial",
          taskRequestId: "R-0001",
          taskRequestStatus: "active",
          taskRequestCreated: true,
          sessionRunBound: true,
        },
      }),
      JSON.stringify({
        ts: "2026-07-18T10:00:01.000Z",
        tsMs: 2,
        stage: "git_context_service",
        event: "task_finalization_started",
        runId: "RUN-1",
        taskId: "T-20260718-0001",
        data: { requestedOutcome: "done", validation: "passed" },
      }),
      JSON.stringify({
        ts: "2026-07-18T10:00:02.000Z",
        tsMs: 3,
        stage: "git_context_service",
        event: "task_finalization_completed",
        runId: "RUN-1",
        taskId: "T-20260718-0001",
        data: {
          outcome: "done",
          taskHeadAfter: commit,
          taskCommit: commit,
          taskCommitCreated: true,
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
    expect(result.stdout).toContain("Task selections: 1");
    expect(result.stdout).toContain("Session runs bound to tasks: 1");
    expect(result.stdout).toContain("initial | R-0001 (active)");
    expect(result.stdout).toContain("committed (done, passed)");
  });

  it("reports incomplete task selection data", async () => {
    const input = join(tempDir, "invalid.jsonl");
    await writeFile(input, `${JSON.stringify({
      ts: "2026-07-18T10:00:00.000Z",
      tsMs: 1,
      stage: "git_context_service",
      event: "task_run_started",
      runId: "RUN-1",
      taskId: "T-20260718-0001",
      data: {},
    })}\n`, "utf8");

    const result = spawnSync(process.execPath, [reportScript, "--input", input], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FAIL — 3 lifecycle/outcome finding(s).");
    expect(result.stdout).toContain("no stable working directory");
    expect(result.stdout).toContain("no explicit request decision");
    expect(result.stdout).toContain("no request identity");
  });
});
