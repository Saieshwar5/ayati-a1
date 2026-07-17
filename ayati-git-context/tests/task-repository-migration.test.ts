import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";
import { validateTaskRepository } from "../src/tasks/task-repository-validator.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const services: SqliteGitContextService[] = [];
const at = "2026-07-17T18:00:00+05:30";

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("legacy task repository migration", () => {
  it("inventories and migrates a clean managed W task without changing its bare repository", async () => {
    const fixture = await createFixture();
    const legacy = await fixture.service.createTask({
      requestId: "REQ-create-legacy",
      sessionId: fixture.sessionId,
      title: "Legacy Learning Path",
      objective: "Continue a multi-day learning path.",
      placement: { mode: "managed" },
      at,
    });
    const bareHead = await git(legacy.task.repositoryPath, ["rev-parse", "refs/heads/main"]);
    const inventory = await fixture.service.inventoryTaskMigrations({ taskId: legacy.task.taskId });

    expect(inventory.tasks).toEqual([expect.objectContaining({
      taskId: "W-20260717-0001",
      cohort: "managed_clean",
      migrationStatus: "pending",
      catalogHead: bareHead,
      workingHead: bareHead,
      legacyHead: bareHead,
    })]);

    const migrated = await fixture.service.migrateTaskRepository({
      requestId: "REQ-migrate-legacy",
      taskId: legacy.task.taskId,
      expectedTaskHead: bareHead,
      at: "2026-07-17T18:01:00+05:30",
    });
    // Simulate a process crash after Git committed but before the catalog
    // acknowledged the V1 writer boundary.
    fixture.database.prepare([
      "UPDATE tasks SET layout_version = 'legacy_independent_v0', repository_path = ?, head_sha = ?,",
      "migration_status = 'in_progress', migration_commit = NULL WHERE task_id = ?",
    ].join(" ")).run(legacy.task.repositoryPath, bareHead, legacy.task.taskId);
    fixture.database.prepare([
      "UPDATE task_repository_migrations SET phase = 'committed' WHERE task_id = ?",
    ].join(" ")).run(legacy.task.taskId);
    const recovered = await fixture.service.migrateTaskRepository({
      requestId: "REQ-migrate-legacy-retry",
      taskId: legacy.task.taskId,
      expectedTaskHead: bareHead,
      at: "2026-07-17T18:01:01+05:30",
    });
    const retried = await fixture.service.migrateTaskRepository({
      requestId: "REQ-migrate-legacy-final-retry",
      taskId: legacy.task.taskId,
      expectedTaskHead: bareHead,
      at: "2026-07-17T18:01:02+05:30",
    });

    expect(migrated).toMatchObject({
      migrated: true,
      baseHead: bareHead,
      legacyRepositoryPath: legacy.task.repositoryPath,
      task: {
        taskId: legacy.task.taskId,
        layoutVersion: "simple_repository_v1",
        repositoryPath: legacy.task.workingPath,
        workingPath: legacy.task.workingPath,
      },
    });
    expect(recovered).toMatchObject({ migrated: true, migrationCommit: migrated.migrationCommit });
    expect(retried).toMatchObject({ migrated: false, migrationCommit: migrated.migrationCommit });
    expect(await git(legacy.task.repositoryPath, ["rev-parse", "refs/heads/main"])).toBe(bareHead);
    expect(await git(legacy.task.workingPath, ["rev-parse", "HEAD^"])).toBe(bareHead);
    expect(await validateTaskRepository({
      taskRoot: join(fixture.workspaceRoot, "tasks"),
      repositoryPath: legacy.task.workingPath,
      expectedTaskId: legacy.task.taskId,
    })).toMatchObject({ health: "ready", head: migrated.migrationCommit });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM session_task_mounts").get())
      .toEqual({ count: 0 });
  });

  it("blocks dirty and external-path cohorts without committing or switching writers", async () => {
    const fixture = await createFixture();
    const dirty = await fixture.service.createTask({
      requestId: "REQ-create-dirty",
      sessionId: fixture.sessionId,
      title: "Dirty Legacy Task",
      objective: "Prove unowned changes are preserved.",
      placement: { mode: "managed" },
      at,
    });
    await writeFile(join(dirty.task.workingPath, "unowned.txt"), "keep me\n", "utf8");
    const externalPath = join(fixture.root, "external-task");
    const external = await fixture.service.createTask({
      requestId: "REQ-create-external",
      sessionId: fixture.sessionId,
      title: "External Legacy Task",
      objective: "Remain external until the user chooses an import.",
      placement: { mode: "requested", workingDirectory: externalPath },
      at,
    });

    const inventory = await fixture.service.inventoryTaskMigrations({});
    expect(inventory.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: dirty.task.taskId, cohort: "dirty" }),
      expect.objectContaining({ taskId: external.task.taskId, cohort: "external_path" }),
    ]));
    await expect(fixture.service.migrateTaskRepository({
      requestId: "REQ-migrate-dirty",
      taskId: dirty.task.taskId,
      expectedTaskHead: dirty.task.head,
      at: "2026-07-17T18:02:00+05:30",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect((await fixture.service.getTask({ taskId: dirty.task.taskId })).task.layoutVersion)
      .toBe("legacy_independent_v0");
    expect(await git(dirty.task.workingPath, ["status", "--short"])).toContain("unowned.txt");
  });

  it("classifies diverged, missing, invalid, and busy legacy writers conservatively", async () => {
    const fixture = await createFixture();
    const diverged = await createLegacy(fixture, "diverged", "Diverged Task");
    await writeFile(join(diverged.workingPath, "committed.txt"), "local only\n", "utf8");
    await git(diverged.workingPath, ["add", "committed.txt"]);
    await git(diverged.workingPath, ["commit", "-m", "local divergence"]);

    const missing = await createLegacy(fixture, "missing", "Missing Task");
    await rm(missing.workingPath, { recursive: true, force: true });

    const invalid = await createLegacy(fixture, "invalid", "Invalid Task");
    await git(invalid.workingPath, ["checkout", "-b", "wrong-branch"]);

    const busy = await createLegacy(fixture, "busy", "Busy Task");
    const conversation = await fixture.service.appendConversation({
      requestId: "REQ-busy-conversation",
      sessionId: fixture.sessionId,
      role: "user",
      content: "Keep this task busy.",
      at,
    });
    const run = await fixture.service.startRun({
      requestId: "REQ-busy-run",
      sessionId: fixture.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: initialWorkState(),
      at,
    });
    fixture.database.prepare("UPDATE runs SET task_id = ?, run_class = 'task' WHERE run_id = ?")
      .run(busy.taskId, run.run.runId);

    const inventory = await fixture.service.inventoryTaskMigrations({});
    expect(inventory.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: diverged.taskId, cohort: "diverged" }),
      expect.objectContaining({ taskId: missing.taskId, cohort: "missing_checkout" }),
      expect.objectContaining({ taskId: invalid.taskId, cohort: "invalid" }),
      expect.objectContaining({ taskId: busy.taskId, cohort: "busy" }),
    ]));
  });
});

async function createLegacy(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  id: string,
  title: string,
) {
  const created = await fixture.service.createTask({
    requestId: "REQ-create-" + id,
    sessionId: fixture.sessionId,
    title,
    objective: "Exercise the " + id + " migration cohort.",
    placement: { mode: "managed" },
    at,
  });
  return {
    taskId: created.task.taskId,
    workingPath: created.task.workingPath,
  };
}

function initialWorkState() {
  return {
    status: "not_done" as const,
    summary: "Run started.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}

async function createFixture(): Promise<{
  root: string;
  workspaceRoot: string;
  database: ContextDatabase;
  service: SqliteGitContextService;
  sessionId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ayati-task-migration-"));
  temporaryDirectories.push(root);
  const workspaceRoot = join(root, "workspace");
  const database = await ContextDatabase.open({ path: join(root, "context.db") });
  const service = new SqliteGitContextService({ database, dataRoot: root, workspaceRoot, now: () => at });
  services.push(service);
  const session = await service.ensureActiveSession({
    requestId: "REQ-session",
    date: "2026-07-17",
    timezone: "Asia/Kolkata",
    agentId: "local",
    at,
  });
  return { root, workspaceRoot, database, service, sessionId: session.session.sessionId };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}
