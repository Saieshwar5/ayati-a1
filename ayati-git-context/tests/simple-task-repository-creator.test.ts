import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { insertSession } from "../src/repositories/session-records.js";
import { readTaskInitialization } from "../src/repositories/task-records.js";
import { TaskLifecycleService } from "../src/services/task-lifecycle-service.js";
import {
  parseSimpleTaskCommit,
} from "../src/tasks/task-commit-metadata.js";
import type { SimpleTaskCreationPhase } from "../src/tasks/simple-task-repository-creator.js";
import { git } from "./simple-task-repository-fixtures.js";

const temporaryDirectories: string[] = [];
const databases: ContextDatabase[] = [];
const at = "2026-07-17T12:00:00+05:30";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("simple task repository creator", () => {
  it("creates one independently readable normal repository and retries idempotently", async () => {
    const fixture = await createLifecycle();
    const input = creationInput("REQ-simple-create", "Learn machine learning");

    const created = await fixture.lifecycle.createSimpleTask(input);
    const retried = await fixture.lifecycle.createSimpleTask(input);
    const context = await fixture.lifecycle.getTask({ taskId: created.task.taskId });

    expect(retried).toEqual(created);
    expect(created).toMatchObject({
      created: true,
      task: {
        taskId: "T-20260717-0001",
        layoutVersion: "simple_repository_v1",
        branch: "main",
        status: "active",
      },
    });
    expect(created.task.repositoryPath).toBe(created.task.workingPath);
    expect(created.task.repositoryPath).toBe(join(
      fixture.workspaceRoot,
      "tasks",
      "T-20260717-0001-learn-machine-learning",
    ));
    expect(await readdir(join(fixture.workspaceRoot, "tasks"))).toEqual([
      "T-20260717-0001-learn-machine-learning",
    ]);
    expect(await git(created.task.repositoryPath, ["rev-parse", "--is-bare-repository"]))
      .toBe("false");
    expect(await git(created.task.repositoryPath, ["branch", "--show-current"]))
      .toBe("main");
    expect(await git(created.task.repositoryPath, ["rev-list", "--count", "HEAD"]))
      .toBe("1");
    expect(await git(created.task.repositoryPath, ["remote"])).toBe("");
    expect(await git(created.task.repositoryPath, ["status", "--porcelain", "--untracked-files=all"]))
      .toBe("");
    expect(parseSimpleTaskCommit(await git(created.task.repositoryPath, [
      "log",
      "-1",
      "--format=%B",
    ]))).toMatchObject({
      event: "task_created",
      taskId: "T-20260717-0001",
      requestId: "R-0001",
    });
    expect(context).toMatchObject({
      task: { title: "Learn machine learning" },
      context: {
        schemaVersion: "ayati.task/v1",
        lifecycleStatus: "active",
        repositoryHealth: "ready",
        currentRequest: {
          id: "R-0001",
          title: "Learn machine learning",
          request: "Build durable understanding through explanations and exercises.",
          acceptance: [
            "The initial task objective is completed and deterministically verified.",
          ],
        },
      },
    });
    expect(fixture.database.prepare([
      "SELECT status, completed_at FROM idempotency_requests WHERE request_id = ?",
    ].join(" ")).get(input.requestId)).toMatchObject({
      status: "completed",
      completed_at: at,
    });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM session_task_mounts").get())
      .toMatchObject({ count: 0 });
  });

  it("allocates deterministic distinct identities for duplicate titles", async () => {
    const fixture = await createLifecycle();

    const first = await fixture.lifecycle.createSimpleTask(
      creationInput("REQ-simple-1", "Repeated title"),
    );
    const second = await fixture.lifecycle.createSimpleTask(
      creationInput("REQ-simple-2", "Repeated title"),
    );

    expect(first.task.taskId).toBe("T-20260717-0001");
    expect(second.task.taskId).toBe("T-20260717-0002");
    expect(first.task.repositoryPath).not.toBe(second.task.repositoryPath);
    expect((await readdir(join(fixture.workspaceRoot, "tasks"))).sort()).toEqual([
      "T-20260717-0001-repeated-title",
      "T-20260717-0002-repeated-title",
    ]);
  });

  it.each([
    "allocated",
    "directory_created",
    "git_initialized",
    "scaffold_written",
    "identity_committed",
    "repository_validated",
    "catalog_activated",
  ] satisfies SimpleTaskCreationPhase[])(
    "recovers an interruption at the %s phase without duplicating the task",
    async (phase) => {
      let failed = false;
      const fixture = await createLifecycle(async (current) => {
        if (!failed && current === phase) {
          failed = true;
          throw new Error("Injected creation interruption at " + phase);
        }
      });
      const input = creationInput("REQ-interrupted-" + phase, "Recover task");

      await expect(fixture.lifecycle.createSimpleTask(input)).rejects.toThrow();
      expect(fixture.database.prepare([
        "SELECT status FROM idempotency_requests WHERE request_id = ?",
      ].join(" ")).get(input.requestId)).toMatchObject({ status: "recovery_required" });
      const recovering = new TaskLifecycleService({
        database: fixture.database,
        dataRoot: fixture.root,
        workspaceRoot: fixture.workspaceRoot,
        now: () => at,
      });

      const recovered = await recovering.createSimpleTask(input);

      expect(recovered.task.taskId).toBe("T-20260717-0001");
      expect(await readdir(join(fixture.workspaceRoot, "tasks"))).toEqual([
        "T-20260717-0001-recover-task",
      ]);
      expect(await git(recovered.task.repositoryPath, ["rev-list", "--count", "HEAD"]))
        .toBe("1");
      expect(await git(recovered.task.repositoryPath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])).toBe("");
      expect(fixture.database.prepare([
        "SELECT status FROM idempotency_requests WHERE request_id = ?",
      ].join(" ")).get(input.requestId)).toMatchObject({ status: "completed" });
    },
  );

  it("recovers initializing V1 repositories during startup", async () => {
    const fixture = await createLifecycle((phase) => {
      if (phase === "scaffold_written") throw new Error("Stop before identity commit");
    });
    const input = creationInput("REQ-startup-recovery", "Startup recovery");
    await expect(fixture.lifecycle.createSimpleTask(input)).rejects.toThrow();
    const recovering = new TaskLifecycleService({
      database: fixture.database,
      dataRoot: fixture.root,
      workspaceRoot: fixture.workspaceRoot,
      now: () => at,
    });

    await recovering.recoverInitializingState();

    expect(readTaskInitialization(fixture.database, "T-20260717-0001")).toMatchObject({
      status: "active",
      layoutVersion: "simple_repository_v1",
      head: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    const retried = await recovering.createSimpleTask(input);
    expect(retried.task.taskId).toBe("T-20260717-0001");
    expect(fixture.database.prepare([
      "SELECT status FROM idempotency_requests WHERE request_id = ?",
    ].join(" ")).get(input.requestId)).toMatchObject({ status: "completed" });
  });

  it("preserves and rejects ambiguous content in an interrupted target", async () => {
    const fixture = await createLifecycle((phase) => {
      if (phase === "directory_created") throw new Error("Stop after directory creation");
    });
    const input = creationInput("REQ-ambiguous", "Preserve ambiguous data");
    await expect(fixture.lifecycle.createSimpleTask(input)).rejects.toThrow();
    const task = readTaskInitialization(fixture.database, "T-20260717-0001");
    if (!task) throw new Error("Expected initializing task record.");
    const userFile = join(task.repositoryPath, "keep-me.txt");
    await writeFile(userFile, "user data\n", "utf8");
    const contentBeforeRecovery = (await readdir(task.repositoryPath)).sort();
    const recovering = new TaskLifecycleService({
      database: fixture.database,
      dataRoot: fixture.root,
      workspaceRoot: fixture.workspaceRoot,
      now: () => at,
    });

    await expect(recovering.createSimpleTask(input)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });

    expect(await readFile(userFile, "utf8")).toBe("user data\n");
    expect((await readdir(task.repositoryPath)).sort()).toEqual(contentBeforeRecovery);
    expect(readTaskInitialization(fixture.database, task.taskId)).toMatchObject({
      status: "initializing",
      head: null,
    });
  });

  it("never adopts a pre-existing empty directory on initial attempt or retry", async () => {
    const fixture = await createLifecycle();
    const target = join(
      fixture.workspaceRoot,
      "tasks",
      "T-20260717-0001-pre-existing-task",
    );
    await mkdir(target, { recursive: true });
    const input = creationInput("REQ-pre-existing", "Pre-existing task");

    await expect(fixture.lifecycle.createSimpleTask(input)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const recovering = new TaskLifecycleService({
      database: fixture.database,
      dataRoot: fixture.root,
      workspaceRoot: fixture.workspaceRoot,
      now: () => at,
    });
    await expect(recovering.createSimpleTask(input)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });

    expect(await readdir(target)).toEqual([]);
    expect(readTaskInitialization(fixture.database, "T-20260717-0001")).toMatchObject({
      status: "initializing",
      head: null,
    });
  });

  it("rejects external requested placement before allocating state", async () => {
    const fixture = await createLifecycle();
    const input = {
      ...creationInput("REQ-external", "External task"),
      placement: { mode: "requested", workingDirectory: "/tmp/external-task" },
    } as const;

    await expect(fixture.lifecycle.createSimpleTask(input)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });

    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM tasks").get())
      .toMatchObject({ count: 0 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM idempotency_requests").get())
      .toMatchObject({ count: 0 });
  });
});

function creationInput(requestId: string, title: string) {
  return {
    requestId,
    sessionId: "S-20260717-local",
    title,
    objective: "Build durable understanding through explanations and exercises.",
    placement: { mode: "managed" },
    at,
  } as const;
}

async function createLifecycle(
  hook?: (phase: SimpleTaskCreationPhase) => void | Promise<void>,
): Promise<{
  root: string;
  workspaceRoot: string;
  database: ContextDatabase;
  lifecycle: TaskLifecycleService;
}> {
  const root = await mkdtemp(join(tmpdir(), "ayati-simple-create-"));
  temporaryDirectories.push(root);
  const workspaceRoot = join(root, "workspace");
  const database = await ContextDatabase.open({ path: ":memory:" });
  databases.push(database);
  insertSession(database, {
    sessionId: "S-20260717-local",
    date: "2026-07-17",
    timezone: "Asia/Kolkata",
    agentId: "local",
    repositoryPath: join(root, "sessions", "S-20260717-local"),
    createdAt: at,
  });
  return {
    root,
    workspaceRoot,
    database,
    lifecycle: new TaskLifecycleService({
      database,
      dataRoot: root,
      workspaceRoot,
      now: () => at,
      ...(hook ? { simpleTaskCreationHook: hook } : {}),
    }),
  };
}
