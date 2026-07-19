import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeRunRequest, SessionRef } from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { updateTaskHead } from "../src/repositories/task-records.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";
import { SimpleTaskFinalizationService } from "../src/services/simple-task-finalization-service.js";
import { MutationBoundaryService } from "../src/services/mutation-boundary-service.js";
import { TaskLifecycleService } from "../src/services/task-lifecycle-service.js";
import { planTaskRequestChange } from "../src/tasks/task-request-lifecycle.js";
import { validateTaskRepository } from "../src/tasks/task-repository-validator.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];
const at = "2026-07-17T16:00:00+05:30";

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("live V1 task request routing", () => {
  it("binds a continuation plan to the exact committed active request", async () => {
    const fixture = await createFixture({ completeInitialRequest: false });

    const planned = await fixture.service.planTaskRequestRoute({
      requestId: "REQ-plan-continuation",
      sessionId: fixture.session.sessionId,
      conversationId: fixture.conversationId,
      runId: fixture.runId,
      taskId: fixture.taskId,
      expectedTaskHead: fixture.taskHead,
      route: {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "The user is continuing the unfinished initial outcome.",
      },
      at: "2026-07-17T16:01:00+05:30",
    });

    expect(planned).toMatchObject({
      taskRequestId: "R-0001",
      requestCreated: false,
      phase: "planned",
      run: {
        runId: fixture.runId,
        taskBinding: { taskId: fixture.taskId, taskRequestId: "R-0001" },
      },
    });
    expect(fixture.database.prepare(
      "SELECT change_plan_json FROM task_request_route_plans WHERE run_id = ?",
    ).get(fixture.runId)).toEqual({ change_plan_json: null });
    expect(await git(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(fixture.taskHead);
  });

  it("projects candidates and applies a new request with verified work in one commit", async () => {
    const fixture = await createFixture();
    const before = await fixture.service.getActiveContext({ sessionId: fixture.session.sessionId });
    expect(before.taskCandidates).toContainEqual(expect.objectContaining({
      taskId: fixture.taskId,
      lifecycleStatus: "active",
      repositoryHealth: "ready",
    }));
    expect(before.taskCandidates?.find((task) => task.taskId === fixture.taskId))
      .not.toHaveProperty("currentRequest");

    const routeInput = requestRouteInput(fixture);
    const planned = await fixture.service.planTaskRequestRoute(routeInput);
    const retried = await fixture.service.planTaskRequestRoute(routeInput);

    expect(retried).toEqual(planned);
    expect(planned).toMatchObject({
      taskId: fixture.taskId,
      taskRequestId: "R-0002",
      baseHead: fixture.taskHead,
      phase: "planned",
      requestCreated: true,
      run: {
        runId: fixture.runId,
        taskBinding: { taskId: fixture.taskId, taskRequestId: "R-0002" },
      },
    });
    expect(await git(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(fixture.taskHead);
    expect(await git(fixture.repositoryPath, ["status", "--porcelain", "--untracked-files=all"]))
      .toBe("");
    const projected = await fixture.service.getActiveContext({
      sessionId: fixture.session.sessionId,
    });
    expect(projected.activeTask?.currentRequest).toMatchObject({
      id: "R-0002",
      title: "Add the next lesson",
      status: "active",
    });

    const authorityInput = {
      requestId: "REQ-authority",
      sessionId: fixture.session.sessionId,
      runId: fixture.runId,
      taskId: fixture.taskId,
      taskRequestId: "R-0002",
      expectedTaskHead: fixture.taskHead,
      targets: [{ path: "lessons/next.md", kind: "file" }],
      at: "2026-07-17T16:02:00+05:30",
    } as const;
    const authority = await fixture.service.acquireMutationAuthority(authorityInput);
    fixture.database.prepare([
      "UPDATE idempotency_requests SET status = 'in_progress', completed_at = NULL",
      "WHERE request_id = ?",
    ].join(" ")).run(authorityInput.requestId);
    fixture.database.prepare([
      "UPDATE task_request_route_plans SET phase = 'planned', authority_id = NULL",
      "WHERE run_id = ?",
    ].join(" ")).run(fixture.runId);
    const resumedAuthority = await fixture.service.acquireMutationAuthority(authorityInput);
    expect(resumedAuthority).toEqual(authority);
    expect(fixture.database.prepare([
      "SELECT phase, authority_id FROM task_request_route_plans WHERE run_id = ?",
    ].join(" ")).get(fixture.runId)).toEqual({
      phase: "authority_acquired",
      authority_id: authority.authority.authorityId,
    });
    await mkdir(join(fixture.repositoryPath, "lessons"), { recursive: true });
    await writeFile(join(fixture.repositoryPath, "lessons", "next.md"), "# Next lesson\n");
    await fixture.service.verifyMutation({
      requestId: "REQ-verify",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "completed",
      at: "2026-07-17T16:03:00+05:30",
    });

    const finalized = await fixture.service.finalizeRun(finalizationInput(fixture, "done"));

    expect(finalized).toMatchObject({
      commit: { status: "committed", headBefore: fixture.taskHead },
    });
    expect((await git(fixture.repositoryPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
    ])).split("\n").sort()).toEqual([
      ".ayati/requests/R-0002-add-the-next-lesson.md",
      ".ayati/task.md",
      "lessons/next.md",
    ]);
    const validation = await validateTaskRepository({
      taskRoot: fixture.taskRoot,
      repositoryPath: fixture.repositoryPath,
      expectedTaskId: fixture.taskId,
      requestReadMode: "all",
    });
    expect(validation.requests.find((request) => request.id === "R-0002"))
      .toMatchObject({ status: "done", title: "Add the next lesson" });
    expect(validation.taskCard.currentRequest).toBeNull();
    expect(fixture.database.prepare([
      "SELECT phase, commit_head FROM task_request_route_plans WHERE run_id = ?",
    ].join(" ")).get(fixture.runId)).toEqual({
      phase: "committed",
      commit_head: finalized.commit.status === "committed" ? finalized.commit.headAfter : null,
    });
  });

  it("discards a newly planned request when failed work produced no durable change", async () => {
    const fixture = await createFixture();
    await fixture.service.planTaskRequestRoute(requestRouteInput(fixture));
    const authority = await fixture.service.acquireMutationAuthority({
      requestId: "REQ-authority-failed",
      sessionId: fixture.session.sessionId,
      runId: fixture.runId,
      taskId: fixture.taskId,
      taskRequestId: "R-0002",
      expectedTaskHead: fixture.taskHead,
      targets: [{ path: "lessons/next.md", kind: "file" }],
      at: "2026-07-17T16:02:00+05:30",
    });
    await fixture.service.verifyMutation({
      requestId: "REQ-verify-failed",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "failed",
      at: "2026-07-17T16:03:00+05:30",
    });

    const finalized = await fixture.service.finalizeRun(finalizationInput(fixture, "failed"));

    expect(finalized).toMatchObject({
      commit: { status: "not_required" },
    });
    expect(fixture.database.prepare(
      "SELECT phase FROM task_request_route_plans WHERE run_id = ?",
    ).get(fixture.runId)).toEqual({ phase: "discarded" });
    expect(await readFile(
      resolve(fixture.repositoryPath, ".ayati/requests/R-0002-add-the-next-lesson.md"),
      "utf8",
    ).catch(() => undefined)).toBeUndefined();
    const validation = await validateTaskRepository({
      taskRoot: fixture.taskRoot,
      repositoryPath: fixture.repositoryPath,
      expectedTaskId: fixture.taskId,
      requestReadMode: "all",
    });
    expect(validation.requests.map((request) => request.id)).toEqual(["R-0001"]);
  });

  it("recovers a committed request plan after interruption before SQLite acknowledgement", async () => {
    const fixture = await createFixture();
    await fixture.service.planTaskRequestRoute(requestRouteInput(fixture));
    const authority = await fixture.service.acquireMutationAuthority({
      requestId: "REQ-authority-recovery",
      sessionId: fixture.session.sessionId,
      runId: fixture.runId,
      taskId: fixture.taskId,
      taskRequestId: "R-0002",
      expectedTaskHead: fixture.taskHead,
      targets: [{ path: "lessons/next.md", kind: "file" }],
      at: "2026-07-17T16:02:00+05:30",
    });
    await mkdir(join(fixture.repositoryPath, "lessons"), { recursive: true });
    await writeFile(join(fixture.repositoryPath, "lessons", "next.md"), "# Recoverable lesson\n");
    await fixture.service.verifyMutation({
      requestId: "REQ-verify-recovery",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "completed",
      at: "2026-07-17T16:03:00+05:30",
    });
    const interrupted = new SimpleTaskFinalizationService({
      database: fixture.database,
      taskRoot: fixture.taskRoot,
      mutationBoundary: new MutationBoundaryService(fixture.database, fixture.taskRoot),
      hook: (phase) => {
        if (phase === "commit_created") throw new Error("interrupt after request commit");
      },
    });

    await expect(interrupted.finalize(
      finalizationInput(fixture, "done"),
      fixture.session,
    )).rejects.toThrow("interrupt after request commit");
    expect(fixture.database.prepare(
      "SELECT phase FROM task_request_route_plans WHERE run_id = ?",
    ).get(fixture.runId)).toEqual({ phase: "recovery_required" });

    const recovery = new SimpleTaskFinalizationService({
      database: fixture.database,
      taskRoot: fixture.taskRoot,
      mutationBoundary: new MutationBoundaryService(fixture.database, fixture.taskRoot),
    });
    await recovery.recover("2026-07-17T16:05:00+05:30");

    expect(fixture.database.prepare([
      "SELECT phase, commit_head FROM task_request_route_plans WHERE run_id = ?",
    ].join(" ")).get(fixture.runId)).toEqual({
      phase: "committed",
      commit_head: await git(fixture.repositoryPath, ["rev-parse", "HEAD"]),
    });
    expect(await git(fixture.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("3");
  });
});

interface Fixture {
  service: SqliteGitContextService;
  database: ContextDatabase;
  session: SessionRef;
  conversationId: string;
  runId: string;
  taskId: string;
  taskHead: string;
  repositoryPath: string;
  taskRoot: string;
}

async function createFixture(input: {
  completeInitialRequest?: boolean;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ayati-live-request-routing-"));
  temporaryDirectories.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.db") });
  const workspaceRoot = join(root, "workspace");
  const taskRoot = join(workspaceRoot, "tasks");
  const service = new SqliteGitContextService({
    database,
    dataRoot: root,
    workspaceRoot,
    now: () => at,
  });
  services.push(service);
  const ensured = await service.ensureActiveSession({
    requestId: "REQ-session",
    date: "2026-07-17",
    timezone: "Asia/Kolkata",
    agentId: "local",
    at,
  });
  const lifecycle = new TaskLifecycleService({
    database,
    dataRoot: root,
    workspaceRoot,
    now: () => at,
  });
  const created = await lifecycle.createSimpleTask({
    requestId: "REQ-simple-task",
    sessionId: ensured.session.sessionId,
    title: "Long lived learning task",
    objective: "Learn one subject across many bounded lessons.",
    placement: { mode: "managed" },
    at,
  });
  let taskHead = created.task.head;
  if (input.completeInitialRequest !== false) {
    const initial = await validateTaskRepository({
      taskRoot,
      repositoryPath: created.task.repositoryPath,
      expectedTaskId: created.task.taskId,
      requestReadMode: "all",
    });
    const completed = planTaskRequestChange({
      expectedHead: initial.head,
      taskCard: initial.taskCard,
      requests: initial.requests,
    }, {
      kind: "complete",
      requestId: "R-0001",
      outcome: "The initial task setup was accepted.",
      verification: "user_accepted",
    });
    for (const write of completed.writes) {
      await writeFile(resolve(created.task.repositoryPath, write.path), write.content, "utf8");
    }
    await git(created.task.repositoryPath, [
      "add", "--", ...completed.writes.map((write) => write.path),
    ]);
    await git(created.task.repositoryPath, ["commit", "-m", "complete initial request"]);
    taskHead = await git(created.task.repositoryPath, ["rev-parse", "HEAD"]);
    updateTaskHead(database, created.task.taskId, created.task.head, taskHead, at);
  }
  const prepared = await service.prepareContextTurn({
    requestId: "REQ-prepare",
    date: "2026-07-17",
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: "Add and finish the next lesson in this learning task.",
    at: "2026-07-17T16:00:01+05:30",
  });
  return {
    service,
    database,
    session: prepared.session,
    conversationId: prepared.conversation.conversationId,
    runId: prepared.run.runId,
    taskId: created.task.taskId,
    taskHead,
    repositoryPath: created.task.repositoryPath,
    taskRoot,
  };
}

function requestRouteInput(fixture: Fixture) {
  return {
    requestId: "REQ-plan-route",
    sessionId: fixture.session.sessionId,
    conversationId: fixture.conversationId,
    runId: fixture.runId,
    taskId: fixture.taskId,
    expectedTaskHead: fixture.taskHead,
    route: {
      kind: "create_active_request" as const,
      reason: "This is the next bounded lesson in the same learning workstream.",
      title: "Add the next lesson",
      request: "Create and verify the next lesson artifact.",
      acceptance: ["The next lesson file exists and is verified."],
      constraints: ["Keep the lesson inside the task repository."],
    },
    at: "2026-07-17T16:01:00+05:30",
  };
}

function finalizationInput(
  fixture: Fixture,
  outcome: "done" | "failed",
): FinalizeRunRequest {
  const done = outcome === "done";
  return {
    requestId: "REQ-finalize-" + outcome,
    sessionId: fixture.session.sessionId,
    runId: fixture.runId,
    outcome,
    stopReason: done ? "completed" : "failed",
    conversationSummary: "The planned lesson run reached a terminal outcome.",
    summary: done ? "The next lesson was created and verified." : "The lesson attempt failed.",
    validation: done ? "passed" : "failed",
    ...(done ? {} : { next: "Retry the planned lesson when ready." }),
    workState: {
      ...emptyRunWorkState(),
      status: done ? "done" : "not_done",
      summary: done ? "The next lesson was created and verified." : "The lesson attempt failed.",
      artifacts: done ? ["lessons/next.md"] : [],
      nextStep: done ? null : "Retry the planned lesson when ready.",
    },
    task: {
      completion: {
        accepted: done,
        assets: done ? [{
          path: "lessons/next.md",
          kind: "file",
          description: "Verified next lesson.",
          verified: true,
        }] : [],
        missing: done ? [] : ["Next lesson"],
        failures: done ? [] : ["The attempt did not create a durable artifact."],
        criteria: [{ criterion: "The next lesson is verified.", passed: done }],
      },
    },
    assistantResponse: done ? "The next lesson is complete." : "The lesson attempt failed.",
    at: "2026-07-17T16:04:00+05:30",
  };
}

function emptyRunWorkState() {
  return {
    status: "not_done" as const,
    summary: "",
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
  const result = await execFileAsync("git", args, { cwd: repositoryPath, encoding: "utf8" });
  return result.stdout.trim();
}
