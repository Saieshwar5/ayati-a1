import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { beginRecoverableIdempotent } from "../src/database/idempotency.js";
import { allocateTaskMount } from "../src/repositories/task-mount-records.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => {
    await service.close();
  }));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("task submodule mounting", () => {
  it("mounts a canonical task lazily as a clean session submodule", async () => {
    const { service, database } = await createService();
    const session = await ensureSession(service);
    const task = await service.createTask({
      requestId: "REQ-task",
      sessionId: session.session.sessionId,
      title: "Mounted Task",
      objective: "Verify lazy per-session task checkout mounting.",
      at: "2026-07-12T09:10:00+05:30",
    });
    const input = {
      requestId: "REQ-mount",
      sessionId: session.session.sessionId,
      taskId: task.task.taskId,
      expectedHead: session.session.head ?? undefined,
      expectedTaskHead: task.task.head,
      at: "2026-07-12T09:11:00+05:30",
    };

    const mounted = await service.mountTask(input);
    const retried = await service.mountTask(input);
    const independentlyMounted = await service.mountTask({
      ...input,
      requestId: "REQ-mount-again",
    });

    expect(retried).toEqual(mounted);
    expect(mounted).toMatchObject({
      created: true,
      mount: {
        sessionId: session.session.sessionId,
        taskId: task.task.taskId,
        canonicalRepository: task.task.repositoryPath,
        branch: "main",
        mountedHead: task.task.head,
        status: "ready",
      },
    });
    expect(independentlyMounted.created).toBe(false);
    expect(await readFile(
      join(mounted.mount.checkoutPath, ".ayati", "task.md"),
      "utf8",
    )).toContain("Task: " + task.task.taskId);
    expect(await git(mounted.mount.checkoutPath, ["branch", "--show-current"])).toBe("main");
    expect(await git(mounted.mount.checkoutPath, ["rev-parse", "HEAD"])).toBe(task.task.head);
    expect(await git(mounted.mount.checkoutPath, ["status", "--porcelain"])).toBe("");
    expect(await git(mounted.mount.checkoutPath, ["remote", "get-url", "origin"])).toBe(
      task.task.repositoryPath,
    );
    const gitmodules = await readFile(
      join(session.session.repositoryPath, ".gitmodules"),
      "utf8",
    );
    expect(gitmodules).toContain("path = tasks/" + task.task.taskId);
    expect(gitmodules).toContain("url = ../../tasks/");
    expect(gitmodules).toContain("branch = main");
    expect(await git(session.session.repositoryPath, ["rev-parse", "HEAD"])).toBe(
      session.session.head,
    );
    expect(await git(session.session.repositoryPath, [
      "ls-files",
      "--stage",
      "--",
      "tasks/" + task.task.taskId,
    ])).toContain("160000 " + task.task.head);
    expect(database.prepare([
      "SELECT status, mounted_head FROM session_task_mounts",
      "WHERE session_id = ? AND task_id = ?",
    ].join(" ")).get(session.session.sessionId, task.task.taskId)).toMatchObject({
      status: "ready",
      mounted_head: task.task.head,
    });
  });

  it("does not initialize unselected task repositories", async () => {
    const { service } = await createService();
    const session = await ensureSession(service);
    const first = await service.createTask({
      requestId: "REQ-task-1",
      sessionId: session.session.sessionId,
      title: "Selected Task",
      objective: "Mount this task in the session.",
      at: "2026-07-12T09:10:00+05:30",
    });
    const second = await service.createTask({
      requestId: "REQ-task-2",
      sessionId: session.session.sessionId,
      title: "Unselected Task",
      objective: "Keep this task canonical but unmounted.",
      at: "2026-07-12T09:11:00+05:30",
    });
    await service.mountTask({
      requestId: "REQ-mount",
      sessionId: session.session.sessionId,
      taskId: first.task.taskId,
      at: "2026-07-12T09:12:00+05:30",
    });

    await expect(readFile(join(
      session.session.repositoryPath,
      "tasks",
      second.task.taskId,
      ".ayati",
      "task.md",
    ), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mounts a task from an earlier session without changing its history", async () => {
    const { service, database } = await createService();
    const firstSession = await ensureSession(service);
    const task = await service.createTask({
      requestId: "REQ-task",
      sessionId: firstSession.session.sessionId,
      title: "Cross Session Task",
      objective: "Continue the same durable task in a later daily session.",
      at: "2026-07-12T09:18:00+05:30",
    });
    const firstMount = await service.mountTask({
      requestId: "REQ-first-mount",
      sessionId: firstSession.session.sessionId,
      taskId: task.task.taskId,
      at: "2026-07-12T09:19:00+05:30",
    });
    database.prepare([
      "UPDATE sessions SET status = 'sealed', sealed_at = ? WHERE session_id = ?",
    ].join(" ")).run("2026-07-12T23:59:59+05:30", firstSession.session.sessionId);
    const secondSession = await service.ensureActiveSession({
      requestId: "REQ-next-session",
      date: "2026-07-13",
      timezone: "Asia/Kolkata",
      agentId: "local",
      at: "2026-07-13T00:00:01+05:30",
    });
    const secondMount = await service.mountTask({
      requestId: "REQ-second-mount",
      sessionId: secondSession.session.sessionId,
      taskId: task.task.taskId,
      expectedTaskHead: task.task.head,
      at: "2026-07-13T00:01:00+05:30",
    });

    expect(secondMount.mount.checkoutPath).not.toBe(firstMount.mount.checkoutPath);
    expect(secondMount.mount.canonicalRepository).toBe(firstMount.mount.canonicalRepository);
    expect(secondMount.mount.mountedHead).toBe(firstMount.mount.mountedHead);
    expect(await git(task.task.repositoryPath, ["rev-list", "--count", "main"])).toBe("1");
    expect(database.prepare([
      "SELECT COUNT(*) AS count FROM session_task_mounts WHERE task_id = ?",
    ].join(" ")).get(task.task.taskId)).toMatchObject({ count: 2 });
  });

  it("recovers a task mount journaled before submodule creation", async () => {
    const directory = await createTemporaryDirectory();
    const databasePath = join(directory, "context.db");
    const firstDatabase = await ContextDatabase.open({ path: databasePath });
    const firstService = new SqliteGitContextService({
      database: firstDatabase,
      dataRoot: directory,
    });
    const session = await ensureSession(firstService);
    const task = await firstService.createTask({
      requestId: "REQ-task",
      sessionId: session.session.sessionId,
      title: "Recover Mount",
      objective: "Recover submodule creation after a process interruption.",
      at: "2026-07-12T09:13:00+05:30",
    });
    const input = {
      requestId: "REQ-crash-mount",
      sessionId: session.session.sessionId,
      taskId: task.task.taskId,
      expectedTaskHead: task.task.head,
      at: "2026-07-12T09:14:00+05:30",
    };
    beginRecoverableIdempotent({
      database: firstDatabase,
      requestId: input.requestId,
      operation: "mount_task",
      payload: input,
      now: input.at,
      execute: () => {
        const allocation = allocateTaskMount(
          firstDatabase,
          session.session,
          task.task,
          input.at,
        );
        return {
          sessionId: session.session.sessionId,
          taskId: task.task.taskId,
          created: allocation.created,
        };
      },
    });
    await firstService.close();

    const secondDatabase = await ContextDatabase.open({ path: databasePath });
    const secondService = new SqliteGitContextService({
      database: secondDatabase,
      dataRoot: directory,
    });
    services.push(secondService);
    await secondService.getActiveContext({ sessionId: session.session.sessionId });
    const retried = await secondService.mountTask(input);

    expect(retried).toMatchObject({
      created: true,
      mount: {
        taskId: task.task.taskId,
        mountedHead: task.task.head,
        status: "ready",
      },
    });
    expect(await git(retried.mount.checkoutPath, ["status", "--porcelain"])).toBe("");
    expect(secondDatabase.prepare([
      "SELECT COUNT(*) AS count FROM session_task_mounts",
    ].join(" ")).get()).toMatchObject({ count: 1 });
  });

  it("restores a missing checkout from an existing session gitlink", async () => {
    const { service, database } = await createService();
    const session = await ensureSession(service);
    const task = await service.createTask({
      requestId: "REQ-task",
      sessionId: session.session.sessionId,
      title: "Restore Checkout",
      objective: "Restore a missing submodule checkout from its session gitlink.",
      at: "2026-07-12T09:20:00+05:30",
    });
    const mounted = await service.mountTask({
      requestId: "REQ-mount",
      sessionId: session.session.sessionId,
      taskId: task.task.taskId,
      at: "2026-07-12T09:21:00+05:30",
    });
    await rm(mounted.mount.checkoutPath, { recursive: true, force: true });
    database.prepare([
      "UPDATE session_task_mounts",
      "SET status = 'initializing', mounted_head = NULL WHERE session_id = ? AND task_id = ?",
    ].join(" ")).run(session.session.sessionId, task.task.taskId);
    const databasePath = database.path;
    await service.close();
    const restartedDatabase = await ContextDatabase.open({ path: databasePath });
    const restartedService = new SqliteGitContextService({
      database: restartedDatabase,
      dataRoot: dirname(databasePath),
    });
    services.push(restartedService);

    await restartedService.getActiveContext({ sessionId: session.session.sessionId });

    expect(await readFile(
      join(mounted.mount.checkoutPath, ".ayati", "task.md"),
      "utf8",
    )).toContain("Task: " + task.task.taskId);
    expect(await git(mounted.mount.checkoutPath, ["branch", "--show-current"])).toBe("main");
    expect(restartedDatabase.prepare([
      "SELECT status, mounted_head FROM session_task_mounts",
      "WHERE session_id = ? AND task_id = ?",
    ].join(" ")).get(session.session.sessionId, task.task.taskId)).toMatchObject({
      status: "ready",
      mounted_head: task.task.head,
    });
  });

  it("refuses to hide changes in an already-mounted dirty checkout", async () => {
    const { service, database } = await createService();
    const session = await ensureSession(service);
    const task = await service.createTask({
      requestId: "REQ-task",
      sessionId: session.session.sessionId,
      title: "Dirty Checkout",
      objective: "Preserve unexplained checkout changes.",
      at: "2026-07-12T09:15:00+05:30",
    });
    const mounted = await service.mountTask({
      requestId: "REQ-mount",
      sessionId: session.session.sessionId,
      taskId: task.task.taskId,
      at: "2026-07-12T09:16:00+05:30",
    });
    await writeFile(join(mounted.mount.checkoutPath, "uncommitted.txt"), "keep me\n", "utf8");

    await expect(service.mountTask({
      requestId: "REQ-remount",
      sessionId: session.session.sessionId,
      taskId: task.task.taskId,
      at: "2026-07-12T09:17:00+05:30",
    })).rejects.toMatchObject({ code: "TASK_CHECKOUT_DIRTY" });
    expect(await readFile(
      join(mounted.mount.checkoutPath, "uncommitted.txt"),
      "utf8",
    )).toBe("keep me\n");
    expect(database.prepare([
      "SELECT status FROM session_task_mounts WHERE session_id = ? AND task_id = ?",
    ].join(" ")).get(session.session.sessionId, task.task.taskId)).toMatchObject({
      status: "recovery_required",
    });
  });

});

async function createService(): Promise<{
  database: ContextDatabase;
  service: SqliteGitContextService;
}> {
  const directory = await createTemporaryDirectory();
  const database = await ContextDatabase.open({
    path: join(directory, "context.db"),
  });
  const service = new SqliteGitContextService({
    database,
    dataRoot: directory,
    now: () => "2026-07-12T09:00:00+05:30",
  });
  services.push(service);
  return { database, service };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ayati-context-mount-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function ensureSession(service: SqliteGitContextService) {
  return await service.ensureActiveSession({
    requestId: "REQ-session",
    date: "2026-07-12",
    timezone: "Asia/Kolkata",
    agentId: "local",
    at: "2026-07-12T09:00:00+05:30",
  });
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  return result.stdout.trim();
}
