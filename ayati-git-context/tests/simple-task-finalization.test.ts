import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { FinalizeTaskRunRequest, SessionRef, TaskRunOutcome } from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";
import { SimpleTaskFinalizationService } from "../src/services/simple-task-finalization-service.js";
import { TaskLifecycleService } from "../src/services/task-lifecycle-service.js";
import { parseSimpleTaskCommit } from "../src/tasks/task-commit-metadata.js";
import { validateTaskRepository } from "../src/tasks/task-repository-validator.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];
const at = "2026-07-17T14:00:00+05:30";

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("simple task single-commit finalization", () => {
  it.each([
    { outcome: "done", validation: "passed", requestStatus: "done", currentRequest: null },
    { outcome: "incomplete", validation: "not_run", requestStatus: "active", currentRequest: "R-0001" },
    { outcome: "blocked", validation: "not_run", requestStatus: "blocked", currentRequest: null },
    { outcome: "failed", validation: "failed", requestStatus: "active", currentRequest: "R-0001" },
  ] as const)(
    "creates one direct commit and reduces a $outcome run deterministically",
    async ({ outcome, validation, requestStatus, currentRequest }) => {
      const fixture = await createFixture();
      await createVerifiedFile(fixture);
      const sessionHead = fixture.session.head;
      const input = finalizationInput(fixture, outcome, validation, true);

      const finalized = await fixture.service.finalizeTaskRun(input);
      const retried = await fixture.service.finalizeTaskRun(input);

      expect(retried).toEqual(finalized);
      expect(finalized).toMatchObject({
        taskHeadBefore: fixture.taskHead,
        taskHeadAfter: finalized.taskFinalizationCommit,
        taskCommitCreated: true,
      });
      expect(finalized).not.toHaveProperty("sessionCommit");
      expect(await git(fixture.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("2");
      expect(await git(fixture.repositoryPath, ["rev-parse", "HEAD^"])).toBe(fixture.taskHead);
      expect((await git(fixture.repositoryPath, [
        "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
      ])).split("\n").sort()).toEqual([
        ".ayati/requests/R-0001-direct-finalization-task.md",
        ".ayati/task.md",
        "src/app.ts",
      ]);
      const metadata = parseSimpleTaskCommit(await git(
        fixture.repositoryPath,
        ["show", "-s", "--format=%B", "HEAD"],
      ));
      expect(metadata).toMatchObject({
        event: "task_run_finalized",
        taskId: fixture.taskId,
        requestId: "R-0001",
        runId: fixture.runId,
        sessionId: fixture.session.sessionId,
        outcome: outcome === "done" ? "completed" : outcome,
        validation,
      });
      const repository = await validateTaskRepository({
        taskRoot: fixture.taskRoot,
        repositoryPath: fixture.repositoryPath,
        expectedTaskId: fixture.taskId,
      });
      expect(repository.health).toBe("ready");
      expect(repository.taskCard).toMatchObject({
        currentRequest,
        currentSnapshot: summary(outcome),
      });
      expect(repository.requests[0]).toMatchObject({ status: requestStatus });
      expect(fixture.database.prepare(
        "SELECT status FROM task_mutation_authorities WHERE run_id = ?",
      ).get(fixture.runId)).toEqual({ status: "released" });
      expect(fixture.database.prepare(
        "SELECT status FROM runs WHERE run_id = ?",
      ).get(fixture.runId)).toEqual({
        status: outcome === "blocked" ? "blocked" : outcome === "failed" ? "failed" : "completed",
      });
      expect(fixture.database.prepare([
        "SELECT phase, commit_created, commit_head FROM simple_task_finalizations",
        "WHERE run_id = ?",
      ].join(" ")).get(fixture.runId)).toEqual({
        phase: "completed",
        commit_created: 1,
        commit_head: finalized.taskHeadAfter,
      });
      expect((await fixture.service.getActiveContext({ sessionId: fixture.session.sessionId }))
        .session?.session.head).toBe(sessionHead);
    },
  );

  it("creates a context-only completion commit when a successful tool changed no files", async () => {
    const fixture = await createFixture();
    const authority = await acquire(fixture);
    const verification = await fixture.service.verifyMutation({
      requestId: "REQ-verify-no-change",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "completed",
      at: "2026-07-17T14:02:00+05:30",
    });
    expect(verification).toMatchObject({ status: "verified", outcome: "no_changes" });

    const result = await fixture.service.finalizeTaskRun(
      finalizationInput(fixture, "done", "passed", false),
    );

    expect(result.taskCommitCreated).toBe(true);
    expect(await git(fixture.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect((await git(fixture.repositoryPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
    ])).split("\n").sort()).toEqual([
      ".ayati/requests/R-0001-direct-finalization-task.md",
      ".ayati/task.md",
    ]);
  });

  it("does not create an empty commit for failed no-change work", async () => {
    const fixture = await createFixture();
    const authority = await acquire(fixture);
    await fixture.service.verifyMutation({
      requestId: "REQ-verify-failed-no-change",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "failed",
      at: "2026-07-17T14:02:00+05:30",
    });

    const result = await fixture.service.finalizeTaskRun(
      finalizationInput(fixture, "failed", "failed", false),
    );

    expect(result).toMatchObject({
      taskHeadBefore: fixture.taskHead,
      taskHeadAfter: fixture.taskHead,
      taskFinalizationCommit: fixture.taskHead,
      taskCommitCreated: false,
    });
    expect(await git(fixture.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(fixture.database.prepare([
      "SELECT phase, commit_created, commit_head FROM simple_task_finalizations",
      "WHERE run_id = ?",
    ].join(" ")).get(fixture.runId)).toEqual({
      phase: "completed",
      commit_created: 0,
      commit_head: fixture.taskHead,
    });
  });

  it("recovers a commit created before SQLite acknowledgement without duplicating it", async () => {
    const fixture = await createFixture();
    await createVerifiedFile(fixture);
    const input = finalizationInput(fixture, "done", "passed", true);
    let interrupted = false;
    const interruptedService = new SimpleTaskFinalizationService({
      database: fixture.database,
      taskRoot: fixture.taskRoot,
      hook: (phase) => {
        if (phase === "commit_created" && !interrupted) {
          interrupted = true;
          throw new Error("Injected interruption after commit creation");
        }
      },
    });

    await expect(interruptedService.finalize(input, fixture.session)).rejects.toThrow(
      "Injected interruption",
    );
    expect(await git(fixture.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(fixture.database.prepare(
      "SELECT phase FROM simple_task_finalizations WHERE run_id = ?",
    ).get(fixture.runId)).toEqual({ phase: "recovery_required" });

    const recovery = new SimpleTaskFinalizationService({
      database: fixture.database,
      taskRoot: fixture.taskRoot,
    });
    await recovery.recoverCommittedFinalizations("2026-07-17T14:04:00+05:30");
    const recovered = await recovery.finalize({
      ...input,
      requestId: "REQ-finalize-retry-after-restart",
      at: "2026-07-17T14:05:00+05:30",
    }, fixture.session);

    expect(recovered.taskCommitCreated).toBe(true);
    expect(await git(fixture.repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(fixture.database.prepare(
      "SELECT phase FROM simple_task_finalizations WHERE run_id = ?",
    ).get(fixture.runId)).toEqual({ phase: "completed" });
  });

  it("rejects unverified paths and preserves all working-tree content", async () => {
    const fixture = await createFixture();
    await createVerifiedFile(fixture);
    await writeFile(join(fixture.repositoryPath, "outside.txt"), "not verified\n", "utf8");

    await expect(fixture.service.finalizeTaskRun(
      finalizationInput(fixture, "done", "passed", true),
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(await git(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(fixture.taskHead);
    expect(await git(fixture.repositoryPath, ["status", "--porcelain", "--untracked-files=all"]))
      .toContain("outside.txt");
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM simple_task_finalizations",
    ).get()).toEqual({ count: 0 });
  });

  it("rejects same-path content changed after mutation verification", async () => {
    const fixture = await createFixture();
    await createVerifiedFile(fixture);
    await writeFile(join(fixture.repositoryPath, "src", "app.ts"), "tampered after verify\n");

    await expect(fixture.service.finalizeTaskRun(
      finalizationInput(fixture, "done", "passed", true),
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(await git(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(fixture.taskHead);
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM simple_task_finalizations",
    ).get()).toEqual({ count: 0 });
  });

  it("does not overwrite engine context changed after the plan was journaled", async () => {
    const fixture = await createFixture();
    await createVerifiedFile(fixture);
    const input = finalizationInput(fixture, "done", "passed", true);
    const taskCardPath = join(fixture.repositoryPath, ".ayati", "task.md");
    const direct = new SimpleTaskFinalizationService({
      database: fixture.database,
      taskRoot: fixture.taskRoot,
      hook: async (phase) => {
        if (phase === "plan_persisted") {
          await writeFile(taskCardPath, "external context edit\n", "utf8");
        }
      },
    });

    await expect(direct.finalize(input, fixture.session)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });

    expect(await readFile(taskCardPath, "utf8")).toBe("external context edit\n");
    expect(await git(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(fixture.taskHead);
    expect(fixture.database.prepare(
      "SELECT phase FROM simple_task_finalizations WHERE run_id = ?",
    ).get(fixture.runId)).toEqual({ phase: "recovery_required" });
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

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ayati-simple-finalization-"));
  temporaryDirectories.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.db") });
  const workspaceRoot = join(root, "workspace");
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
  const conversation = await service.appendConversation({
    requestId: "REQ-message",
    sessionId: ensured.session.sessionId,
    role: "user",
    content: "Finalize the direct task work once.",
    at: "2026-07-17T14:00:01+05:30",
  });
  const run = await service.startRun({
    requestId: "REQ-run",
    sessionId: ensured.session.sessionId,
    conversationId: conversation.conversation.conversationId,
    trigger: "user",
    workState: emptyRunWorkState(),
    at: "2026-07-17T14:00:02+05:30",
  });
  const lifecycle = new TaskLifecycleService({
    database,
    dataRoot: root,
    workspaceRoot,
    now: () => at,
  });
  const task = await lifecycle.createSimpleTask({
    requestId: "REQ-simple-task",
    sessionId: ensured.session.sessionId,
    title: "Direct finalization task",
    objective: "Create one recoverable V1 task commit.",
    placement: { mode: "managed" },
    at,
  });
  return {
    service,
    database,
    session: ensured.session,
    conversationId: conversation.conversation.conversationId,
    runId: run.run.runId,
    taskId: task.task.taskId,
    taskHead: task.task.head,
    repositoryPath: task.task.repositoryPath,
    taskRoot: join(workspaceRoot, "tasks"),
  };
}

async function acquire(fixture: Fixture) {
  return await fixture.service.acquireMutationAuthority({
    requestId: "REQ-authority",
    sessionId: fixture.session.sessionId,
    runId: fixture.runId,
    taskId: fixture.taskId,
    taskRequestId: "R-0001",
    expectedTaskHead: fixture.taskHead,
    targets: [{ path: "src/app.ts", kind: "file" }],
    at: "2026-07-17T14:01:00+05:30",
  });
}

async function createVerifiedFile(fixture: Fixture): Promise<void> {
  const authority = await acquire(fixture);
  await mkdir(join(fixture.repositoryPath, "src"), { recursive: true });
  await writeFile(join(fixture.repositoryPath, "src", "app.ts"), "export const ready = true;\n");
  await fixture.service.verifyMutation({
    requestId: "REQ-verify",
    authorityId: authority.authority.authorityId,
    lockToken: authority.authority.lockToken,
    toolStatus: "completed",
    at: "2026-07-17T14:02:00+05:30",
  });
}

function finalizationInput(
  fixture: Fixture,
  outcome: TaskRunOutcome,
  validation: "passed" | "failed" | "not_run",
  includeAsset: boolean,
): FinalizeTaskRunRequest {
  const done = outcome === "done";
  const blocked = outcome === "blocked" || outcome === "needs_user_input";
  return {
    requestId: "REQ-finalize",
    sessionId: fixture.session.sessionId,
    runId: fixture.runId,
    taskId: fixture.taskId,
    outcome,
    conversationSummary: "The direct task run reached a deterministic terminal outcome.",
    summary: summary(outcome),
    validation,
    ...(done ? {} : { next: "Continue from the verified task state." }),
    completion: {
      accepted: done,
      assets: includeAsset ? [{
        path: "src/app.ts",
        kind: "file",
        description: "Verified application entry point.",
        verified: true,
      }] : [],
      missing: done ? [] : ["Remaining request work"],
      failures: blocked ? ["Waiting for required user input"] : [],
      criteria: [{
        criterion: "The requested outcome is deterministically verified.",
        passed: done,
      }],
    },
    assistantResponse: "The task run finished with outcome: " + outcome + ".",
    at: "2026-07-17T14:03:00+05:30",
  };
}

function summary(outcome: TaskRunOutcome): string {
  return "The direct task run finished with verified " + outcome + " state.";
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
