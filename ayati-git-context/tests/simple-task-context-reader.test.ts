import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskCatalogEntry } from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { insertSession } from "../src/repositories/session-records.js";
import { readTaskCatalogEntry } from "../src/repositories/task-records.js";
import { TaskLifecycleService } from "../src/services/task-lifecycle-service.js";
import { parseTaskCard, renderTaskCard } from "../src/tasks/task-card.js";
import { renderTaskRunCommit } from "../src/tasks/task-commit-metadata.js";
import { readTaskContext } from "../src/tasks/task-context-reader.js";
import { TASK_CARD_PATH } from "../src/tasks/task-repository-layout.js";
import { createSimpleTaskFixture, git } from "./simple-task-repository-fixtures.js";

const temporaryDirectories: string[] = [];
const databases: ContextDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("simple task context reader", () => {
  it("migrates existing-style task rows to the explicit legacy layout", async () => {
    const database = await ContextDatabase.open({ path: ":memory:" });
    databases.push(database);
    insertSession(database, {
      sessionId: "S-20260717-local",
      date: "2026-07-17",
      timezone: "Asia/Kolkata",
      agentId: "local",
      repositoryPath: "/tmp/session.git",
      createdAt: "2026-07-17T10:00:00+05:30",
    });
    database.prepare([
      "INSERT INTO tasks(",
      "task_id, repository_path, working_path, durable_branch, head_sha, title_cache,",
      "objective_cache, status, created_session_id, created_at, updated_at",
      ") VALUES (?, ?, ?, 'main', ?, ?, ?, 'active', ?, ?, ?)",
    ].join(" ")).run(
      "W-20260717-0001",
      "/tmp/task.git",
      "/tmp/task",
      "a".repeat(40),
      "Legacy task",
      "Preserve the established reader.",
      "S-20260717-local",
      "2026-07-17T10:00:00+05:30",
      "2026-07-17T10:00:00+05:30",
    );

    expect(readTaskCatalogEntry(database, "W-20260717-0001")?.layoutVersion)
      .toBe("legacy_independent_v0");
  });

  it("projects compact committed context and reports external dirt separately", async () => {
    const taskRoot = await createTaskRoot();
    const fixture = await createSimpleTaskFixture({
      taskRoot,
      taskId: "T-20260717-0001",
      title: "Build coffee website",
      domain: "coding",
    });
    const cardPath = join(fixture.repositoryPath, TASK_CARD_PATH);
    const card = parseTaskCard(await readFile(cardPath, "utf8"));
    await writeFile(cardPath, renderTaskCard({
      ...card,
      currentSnapshot: "The accessible home page is implemented.",
      currentFocus: "Verify responsive navigation.",
    }), "utf8");
    await git(fixture.repositoryPath, ["add", "--", TASK_CARD_PATH]);
    await git(fixture.repositoryPath, [
      "commit",
      "-m",
      renderTaskRunCommit({
        subject: "Finish accessible home page",
        taskId: fixture.taskId,
        requestId: fixture.requestId,
        runId: "RUN-0001",
        sessionId: "S-20260717-local",
        outcome: "incomplete",
        validation: "passed",
        next: "Verify responsive navigation.",
      }),
    ]);
    await git(fixture.repositoryPath, ["commit", "--allow-empty", "-m", "record design note"]);
    const committedHead = await git(fixture.repositoryPath, ["rev-parse", "HEAD"]);
    await writeFile(cardPath, renderTaskCard({
      ...card,
      currentSnapshot: "Uncommitted text must not become durable context.",
    }), "utf8");
    await writeFile(join(fixture.repositoryPath, fixture.importantPath), "external edit\n", "utf8");
    const statusBefore = await git(fixture.repositoryPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);

    const context = await readTaskContext(catalog(fixture.repositoryPath, committedHead), {
      taskRoot,
      includeReferencesSummary: true,
    });

    expect(context).toMatchObject({
      task: {
        taskId: fixture.taskId,
        layoutVersion: "simple_repository_v1",
        head: committedHead,
      },
      title: "Build coffee website",
      objective: "Build and maintain a reliable coffee website.",
      summary: "The accessible home page is implemented.",
      currentFocus: "Verify responsive navigation.",
      lifecycleStatus: "active",
      repositoryHealth: "dirty_external",
      currentRequest: {
        id: "R-0001",
        title: "Build initial website",
        status: "active",
      },
      importantPaths: [fixture.importantPath],
      importantPathDetails: [{
        path: fixture.importantPath,
        description: "Application entry point",
        exists: true,
      }],
      latestOutcome: "incomplete",
      validation: "passed",
      next: "Verify responsive navigation.",
      referencesSummary: { total: 1, available: 1, missing: 0, changed: 0, unchecked: 0 },
    });
    expect(context.recentCommits[0]).toMatchObject({
      subject: "record design note",
    });
    expect(context.recentCommits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "task_run_finalized",
        requestId: "R-0001",
        runId: "RUN-0001",
      }),
    ]));
    expect(await git(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(committedHead);
    expect(await git(fixture.repositoryPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])).toBe(statusBefore);
  });

  it("reads no non-current request bodies and handles paused tasks", async () => {
    const taskRoot = await createTaskRoot();
    const fixture = await createSimpleTaskFixture({
      taskRoot,
      taskId: "T-20260717-0002",
      title: "Paused analysis",
      domain: "analysis",
      taskStatus: "paused",
      requestStatus: "done",
    });
    const malformedRequest = join(fixture.repositoryPath, ".ayati/requests/R-0002-future.md");
    await writeFile(malformedRequest, "This body is intentionally not a request contract.\n", "utf8");
    await git(fixture.repositoryPath, ["add", "--", ".ayati/requests/R-0002-future.md"]);
    await git(fixture.repositoryPath, ["commit", "-m", "queue opaque future request"]);
    const head = await git(fixture.repositoryPath, ["rev-parse", "HEAD"]);

    const context = await readTaskContext(catalog(fixture.repositoryPath, head, fixture.taskId), {
      taskRoot,
    });

    expect(context.lifecycleStatus).toBe("paused");
    expect(context.currentRequest).toBeUndefined();
    expect(context.referencesSummary).toBeUndefined();
  });

  it("keeps history and important-path projection bounded", async () => {
    const taskRoot = await createTaskRoot();
    const fixture = await createSimpleTaskFixture({
      taskRoot,
      taskId: "T-20260717-0004",
      title: "Automation task",
      domain: "automation",
    });
    await git(fixture.repositoryPath, ["rm", "--", fixture.importantPath]);
    await git(fixture.repositoryPath, ["commit", "-m", "remove obsolete implementation"]);
    for (let index = 1; index <= 15; index += 1) {
      await git(fixture.repositoryPath, [
        "commit",
        "--allow-empty",
        "-m",
        "record automation observation " + index,
      ]);
    }
    const head = await git(fixture.repositoryPath, ["rev-parse", "HEAD"]);

    const context = await readTaskContext(catalog(
      fixture.repositoryPath,
      head,
      fixture.taskId,
    ), { taskRoot });

    expect(context.recentCommits).toHaveLength(12);
    expect(context.importantPaths).toEqual([fixture.importantPath]);
    expect(context.importantPathDetails).toEqual([{
      path: fixture.importantPath,
      description: "Invoice extraction implementation",
      exists: false,
    }]);
  });

  it("uses explicit catalog layout, reads Git truth, and rejects V1 mounts without side effects", async () => {
    const taskRoot = await createTaskRoot();
    const fixture = await createSimpleTaskFixture({
      taskRoot,
      taskId: "T-20260717-0003",
      title: "Learning task",
      domain: "learning",
    });
    const head = await git(fixture.repositoryPath, ["rev-parse", "HEAD"]);
    const database = await ContextDatabase.open({ path: ":memory:" });
    databases.push(database);
    insertSession(database, {
      sessionId: "S-20260717-local",
      date: "2026-07-17",
      timezone: "Asia/Kolkata",
      agentId: "local",
      repositoryPath: join(dirname(taskRoot), "sessions", "S-20260717-local"),
      createdAt: "2026-07-17T10:00:00+05:30",
    });
    database.prepare([
      "INSERT INTO tasks(",
      "task_id, layout_version, repository_path, working_path, durable_branch, head_sha,",
      "title_cache, objective_cache, status, created_session_id, created_at, updated_at",
      ") VALUES (?, 'simple_repository_v1', ?, ?, 'main', ?, ?, ?, 'active', ?, ?, ?)",
    ].join(" ")).run(
      fixture.taskId,
      fixture.repositoryPath,
      fixture.repositoryPath,
      head,
      "Stale catalog title",
      "Stale catalog objective",
      "S-20260717-local",
      "2026-07-17T10:00:00+05:30",
      "2026-07-17T10:00:00+05:30",
    );
    const lifecycle = new TaskLifecycleService({
      database,
      dataRoot: dirname(taskRoot),
      workspaceRoot: dirname(taskRoot),
      now: () => "2026-07-17T10:00:00+05:30",
    });
    const catalogBefore = database.prepare([
      "SELECT layout_version, repository_path, working_path, head_sha, title_cache,",
      "objective_cache, status, updated_at FROM tasks WHERE task_id = ?",
    ].join(" ")).get(fixture.taskId);

    const read = await lifecycle.getTask({ taskId: fixture.taskId });

    expect(read.task).toMatchObject({
      layoutVersion: "simple_repository_v1",
      title: "Learning task",
      objective: "Learn machine learning through explanations, exercises, and projects.",
      head,
    });
    expect(read.context).toMatchObject({
      schemaVersion: "ayati.task/v1",
      task: { taskId: fixture.taskId, head },
      currentRequest: { id: "R-0001" },
    });
    expect(database.prepare([
      "SELECT layout_version, repository_path, working_path, head_sha, title_cache,",
      "objective_cache, status, updated_at FROM tasks WHERE task_id = ?",
    ].join(" ")).get(fixture.taskId)).toEqual(catalogBefore);
    await expect(lifecycle.mountTask({
      requestId: "REQ-v1-mount",
      sessionId: "S-20260717-local",
      taskId: fixture.taskId,
      expectedTaskHead: head,
      at: "2026-07-17T10:01:00+05:30",
    }, {
      sessionId: "S-20260717-local",
      repositoryPath: join(dirname(taskRoot), "sessions", "S-20260717-local"),
      head: null,
      date: "2026-07-17",
      timezone: "Asia/Kolkata",
      status: "open",
    })).rejects.toMatchObject({ code: "SERVICE_NOT_READY" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM session_task_mounts").get())
      .toMatchObject({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_requests").get())
      .toMatchObject({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM task_mutation_authorities").get())
      .toMatchObject({ count: 0 });
    expect(readTaskCatalogEntry(database, fixture.taskId)?.layoutVersion)
      .toBe("simple_repository_v1");
  });
});

function catalog(
  repositoryPath: string,
  head: string,
  taskId = "T-20260717-0001",
): TaskCatalogEntry {
  return {
    taskId,
    layoutVersion: "simple_repository_v1",
    repositoryPath,
    workingPath: repositoryPath,
    branch: "main",
    head,
    title: "Stale catalog title",
    objective: "Stale catalog objective",
    status: "active",
    createdSessionId: "S-20260717-local",
    createdAt: "2026-07-17T10:00:00+05:30",
    updatedAt: "2026-07-17T10:00:00+05:30",
  };
}

async function createTaskRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ayati-simple-context-"));
  temporaryDirectories.push(root);
  const taskRoot = join(root, "tasks");
  await mkdir(taskRoot);
  return taskRoot;
}
