import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FinalizeRunRequest,
  PrepareContextTurnResponse,
  SelectedTaskForRunResponse,
  TaskCompletionRecord,
} from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";
import { parseSimpleTaskCommit } from "../src/tasks/task-commit-metadata.js";
import { validateTaskRepository } from "../src/tasks/task-repository-validator.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("task-bound run finalization", () => {
  it("binds task ownership to the existing run and never switches it", async () => {
    const fixture = await createFixture("binding");
    const input = createTaskInput(fixture, "REQ-create-binding");

    const selected = await fixture.service.createTaskForRun(input);
    const replayed = await fixture.service.createTaskForRun(input);

    expect(replayed).toEqual(selected);
    expect(selected).toMatchObject({
      run: {
        runId: fixture.prepared.run.runId,
        taskBinding: {
          taskId: selected.task.taskId,
          taskRequestId: "R-0001",
        },
      },
      taskCreated: true,
      taskRequestDecision: "initial",
      taskRequestCreated: true,
      taskRequestStatus: "active",
      headBeforeSelection: selected.task.head,
    });
    expect(selected.run.runId).toBe(fixture.prepared.run.runId);
    expect(fixture.database.prepare([
      "SELECT task_id, task_request_id FROM runs WHERE run_id = ?",
    ].join(" ")).get(fixture.prepared.run.runId)).toEqual({
      task_id: selected.task.taskId,
      task_request_id: "R-0001",
    });
    await expect(fixture.service.createTaskForRun({
      ...input,
      requestId: "REQ-attempt-rebind",
      title: "Another task",
      objective: "This task must not take ownership of the current run.",
    })).rejects.toMatchObject({ code: "RUN_TASK_BINDING_IMMUTABLE" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM tasks").get())
      .toEqual({ count: 1 });
  });

  it("rejects mutation authority before an existing task is bound to the new run", async () => {
    const fixture = await createFixture("unbound-authority");
    const selected = await bindNewTask(fixture, "REQ-create-authority-task");
    await fixture.service.finalizeRun(failedFinalization(fixture));
    const next = await fixture.service.prepareContextTurn({
      requestId: "REQ-prepare-unbound-authority-next",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Mutate the existing task without selecting it.",
      at: "2026-07-19T11:04:00+05:30",
    });

    await expect(fixture.service.acquireMutationAuthority({
      requestId: "REQ-unbound-authority",
      sessionId: next.session.sessionId,
      runId: next.run.runId,
      taskId: selected.task.taskId,
      taskRequestId: "R-0001",
      expectedTaskHead: selected.task.head,
      targets: [{ path: "src/app.ts", kind: "file" }],
      at: "2026-07-19T11:05:00+05:30",
    })).rejects.toMatchObject({ code: "MUTATION_REQUIRES_TASK_BINDING" });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM task_mutation_authorities WHERE run_id = ?",
    ).get(next.run.runId)).toEqual({ count: 0 });
  });

  it("uses short-lived zero-target authority for a context-only completion commit", async () => {
    const fixture = await createFixture("context-only");
    const selected = await bindNewTask(fixture, "REQ-create-context-only");
    const input = doneFinalization(fixture, selected, []);

    const result = await fixture.service.finalizeRun(input);

    expect(result).toMatchObject({
      run: {
        runId: fixture.prepared.run.runId,
        status: "done",
        stopReason: "completed",
      },
      materialization: { status: "not_requested" },
      commit: {
        status: "committed",
        taskId: selected.task.taskId,
        taskRequestId: "R-0001",
        headBefore: selected.task.head,
      },
    });
    if (result.commit.status !== "committed") throw new Error("Expected a task commit.");
    expect(result.commit.headAfter).toBe(result.commit.commit);
    expect(await git(selected.task.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect((await git(selected.task.repositoryPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
    ])).split("\n").sort()).toEqual([
      ".ayati/requests/R-0001-unified-run-task.md",
      ".ayati/task.md",
    ]);
    expect(fixture.database.prepare(
      "SELECT status FROM task_mutation_authorities WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ status: "released" });
    const validation = await validateTaskRepository({
      taskRoot: fixture.taskRoot,
      repositoryPath: selected.task.repositoryPath,
      expectedTaskId: selected.task.taskId,
    });
    expect(validation).toMatchObject({
      health: "ready",
      taskCard: { currentRequest: null, currentSnapshot: "The requested work is complete." },
      requests: [{ id: "R-0001", status: "done" }],
    });
    expect(fixture.database.prepare([
      "SELECT current_request_id, current_request_title, current_request_status",
      "FROM tasks WHERE task_id = ?",
    ].join(" ")).get(selected.task.taskId)).toEqual({
      current_request_id: null,
      current_request_title: null,
      current_request_status: null,
    });
    expect((await fixture.service.findTasks({ view: "unfinished" })).tasks)
      .not.toContainEqual(expect.objectContaining({ taskId: selected.task.taskId }));
  });

  it("commits verified task mutation and engine-owned context exactly once", async () => {
    const fixture = await createFixture("verified-mutation");
    const selected = await bindNewTask(fixture, "REQ-create-mutation");
    const authority = await fixture.service.acquireMutationAuthority({
      requestId: fixture.prepared.run.runId + ":call-write:authority",
      sessionId: fixture.prepared.session.sessionId,
      runId: fixture.prepared.run.runId,
      taskId: selected.task.taskId,
      taskRequestId: "R-0001",
      expectedTaskHead: selected.task.head,
      targets: [{ path: "src/app.ts", kind: "file" }],
      at: "2026-07-19T11:01:00+05:30",
    });
    await mkdir(join(selected.task.repositoryPath, "src"), { recursive: true });
    await writeFile(
      join(selected.task.repositoryPath, "src", "app.ts"),
      "export const ready = true;\n",
      "utf8",
    );
    const verification = await fixture.service.verifyMutation({
      requestId: fixture.prepared.run.runId + ":call-write:verification",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "completed",
      at: "2026-07-19T11:02:00+05:30",
    });
    expect(verification).toMatchObject({
      verified: true,
      status: "verified",
      outcome: "verified_changes",
      provenance: { created: ["src/app.ts"], unexpectedPaths: [] },
    });
    await fixture.service.recordRunStep({
      requestId: fixture.prepared.run.runId + ":step:1",
      sessionId: fixture.prepared.session.sessionId,
      runId: fixture.prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "completed",
        summary: "Created and verified the application entry point.",
        toolCalls: [{
          callId: "call-write",
          tool: "write_files",
          purpose: "Create the task-owned application entry point.",
          toolPurpose: "mutation",
          toolEffect: "workspace_mutation",
          status: "success",
          input: { path: "src/app.ts" },
          output: { written: ["src/app.ts"] },
        }],
        verification: { passed: true, artifacts: ["src/app.ts"] },
        workStateAfter: {
          ...workState(),
          summary: "Created the application entry point.",
          artifacts: ["src/app.ts"],
        },
        createdAt: "2026-07-19T11:02:01+05:30",
      },
    });
    const input = doneFinalization(fixture, selected, [{
      path: "src/app.ts",
      kind: "file",
      description: "Verified application entry point.",
      verified: true,
    }]);

    const result = await fixture.service.finalizeRun(input);
    const replayed = await fixture.service.finalizeRun(input);

    expect(replayed).toEqual(result);
    expect(result.commit.status).toBe("committed");
    expect(await git(selected.task.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect((await git(selected.task.repositoryPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
    ])).split("\n").sort()).toEqual([
      ".ayati/requests/R-0001-unified-run-task.md",
      ".ayati/task.md",
      "src/app.ts",
    ]);
    const metadata = parseSimpleTaskCommit(await git(
      selected.task.repositoryPath,
      ["show", "-s", "--format=%B", "HEAD"],
    ));
    expect(metadata).toMatchObject({
      taskId: selected.task.taskId,
      requestId: "R-0001",
      runId: fixture.prepared.run.runId,
      sessionId: fixture.prepared.session.sessionId,
      outcome: "completed",
      validation: "passed",
    });
    expect(fixture.database.prepare([
      "SELECT phase, commit_created, commit_head FROM task_finalizations",
      "WHERE run_id = ?",
    ].join(" ")).get(fixture.prepared.run.runId)).toEqual({
      phase: "completed",
      commit_created: 1,
      commit_head: result.commit.status === "committed" ? result.commit.headAfter : null,
    });
  });

  it("closes a bound no-change failure without a task commit or read-context reset", async () => {
    const fixture = await createFixture("no-change");
    await fixture.service.recordRunStep({
      requestId: fixture.prepared.run.runId + ":step:1",
      sessionId: fixture.prepared.session.sessionId,
      runId: fixture.prepared.run.runId,
      record: readStep(),
    });
    const selected = await bindNewTask(fixture, "REQ-create-no-change");
    const input = failedFinalization(fixture);

    const result = await fixture.service.finalizeRun(input);
    const context = await fixture.service.getActiveContext({
      sessionId: fixture.prepared.session.sessionId,
    });

    expect(result).toMatchObject({
      run: { status: "failed", stopReason: "failed" },
      commit: { status: "not_required" },
    });
    expect(await git(selected.task.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(context.readContext).not.toHaveProperty("afterCommitRunId");
    expect(context.readContext?.evidence).toEqual([
      expect.objectContaining({ runId: fixture.prepared.run.runId, tool: "read_files" }),
    ]);
  });

  it("resets reusable read context only after a created task commit", async () => {
    const fixture = await createFixture("read-reset");
    await fixture.service.recordRunStep({
      requestId: fixture.prepared.run.runId + ":step:1",
      sessionId: fixture.prepared.session.sessionId,
      runId: fixture.prepared.run.runId,
      record: readStep(),
    });
    const selected = await bindNewTask(fixture, "REQ-create-read-reset");
    await fixture.service.finalizeRun(doneFinalization(fixture, selected, []));

    const context = await fixture.service.getActiveContext({
      sessionId: fixture.prepared.session.sessionId,
    });
    expect(context.readContext).toMatchObject({
      afterCommitRunId: fixture.prepared.run.runId,
      inventory: [],
      discovery: [],
      evidence: [],
      actions: [],
    });
  });

  it("marks uncertain dirty work recovery-required and never acknowledges a commit", async () => {
    const fixture = await createFixture("dirty-recovery");
    const selected = await bindNewTask(fixture, "REQ-create-dirty");
    await writeFile(join(selected.task.repositoryPath, "unverified.txt"), "unsafe\n", "utf8");

    await expect(fixture.service.finalizeRun(doneFinalization(fixture, selected, [])))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(await git(selected.task.repositoryPath, ["rev-parse", "HEAD"])).toBe(selected.task.head);
    expect(await git(selected.task.repositoryPath, ["status", "--porcelain", "--untracked-files=all"]))
      .toContain("unverified.txt");
    expect(fixture.database.prepare(
      "SELECT status, stop_reason FROM runs WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({
      status: "recovery_required",
      stop_reason: null,
    });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM task_finalizations WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ count: 0 });
  });
});

interface Fixture {
  database: ContextDatabase;
  service: SqliteGitContextService;
  prepared: PrepareContextTurnResponse;
  taskRoot: string;
}

async function createFixture(suffix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ayati-task-bound-run-"));
  roots.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
  const workspaceRoot = join(root, "workspace");
  const service = new SqliteGitContextService({
    database,
    dataRoot: join(root, "session-data"),
    workspaceRoot,
    now: () => "2026-07-19T11:00:00+05:30",
  });
  services.push(service);
  const prepared = await service.prepareContextTurn({
    requestId: "REQ-prepare-" + suffix,
    date: "2026-07-19",
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: "Complete one durable task outcome.",
    at: "2026-07-19T11:00:00+05:30",
  });
  return { database, service, prepared, taskRoot: join(workspaceRoot, "tasks") };
}

function createTaskInput(fixture: Fixture, requestId: string) {
  return {
    requestId,
    sessionId: fixture.prepared.session.sessionId,
    conversationId: fixture.prepared.conversation.conversationId,
    runId: fixture.prepared.run.runId,
    title: "Unified run task",
    objective: "Verify one task-bound run and its durable finalization.",
    placement: { mode: "managed" as const },
    at: "2026-07-19T11:00:01+05:30",
  };
}

async function bindNewTask(
  fixture: Fixture,
  requestId: string,
): Promise<SelectedTaskForRunResponse> {
  return await fixture.service.createTaskForRun(createTaskInput(fixture, requestId));
}

function doneFinalization(
  fixture: Fixture,
  _selected: SelectedTaskForRunResponse,
  assets: TaskCompletionRecord["assets"],
): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    sessionId: fixture.prepared.session.sessionId,
    runId: fixture.prepared.run.runId,
    outcome: "done",
    stopReason: "completed",
    assistantResponse: "The requested task work is complete.",
    conversationSummary: "The user requested one durable task outcome.",
    summary: "The requested work is complete.",
    validation: "passed",
    workState: {
      ...workState(),
      status: "done",
      summary: "The requested work is complete.",
      artifacts: assets.map((asset) => asset.path),
    },
    task: {
      completion: {
        accepted: true,
        assets,
        missing: [],
        failures: [],
        criteria: [{
          criterion: "The requested outcome is deterministically verified.",
          passed: true,
          evidence: "Task-owned evidence passed validation.",
        }],
      },
    },
    at: "2026-07-19T11:03:00+05:30",
  };
}

function failedFinalization(fixture: Fixture): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    sessionId: fixture.prepared.session.sessionId,
    runId: fixture.prepared.run.runId,
    outcome: "failed",
    stopReason: "failed",
    assistantResponse: "The task attempt failed without changing task state.",
    conversationSummary: "The task attempt ended without a durable change.",
    summary: "The task attempt failed without changing task state.",
    validation: "failed",
    workState: {
      ...workState(),
      summary: "The task attempt failed without changing task state.",
    },
    task: {
      completion: {
        accepted: false,
        assets: [],
        missing: ["A verified task outcome"],
        failures: ["The attempt failed."],
        criteria: [{ criterion: "The requested outcome is verified.", passed: false }],
      },
    },
    at: "2026-07-19T11:03:00+05:30",
  };
}

function readStep() {
  return {
    version: 1 as const,
    step: 1,
    status: "completed" as const,
    summary: "Read the relevant file.",
    toolCalls: [{
      callId: "call-read",
      tool: "read_files",
      purpose: "Inspect the relevant file.",
      toolPurpose: "read" as const,
      toolEffect: "read_only" as const,
      status: "success" as const,
      input: { paths: ["package.json"] },
      output: { files: ["package.json"] },
    }],
    verification: { passed: true, resources: ["package.json"] },
    workStateAfter: { ...workState(), summary: "Read the relevant file." },
    createdAt: "2026-07-19T11:00:00+05:30",
  };
}

function workState() {
  return {
    status: "not_done" as const,
    summary: "Task work is active.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  return result.stdout.trim();
}
