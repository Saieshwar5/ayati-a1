import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionAttachmentRecord, TaskCatalogEntry } from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";
import { readSimpleTaskContext } from "../src/tasks/simple-task-context-reader.js";
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

describe("simple task attachments and references", () => {
  it("retains attachment identity and restores it after restart", async () => {
    const fixture = await createFixture();
    const attachment = await createAttachment(fixture.root, "report.csv", "name,value\na,1\n", "SA-report");

    await fixture.service.recordSessionAttachments({
      requestId: "REQ-record-report",
      sessionId: fixture.sessionId,
      conversationId: fixture.conversationId,
      attachments: [attachment],
      at,
    });
    expect((await fixture.service.getActiveContext({ sessionId: fixture.sessionId }))
      .session?.attachments).toMatchObject({
        count: 1,
        recent: [{ sessionAssetId: "SA-report", checksum: attachment.checksum }],
      });

    await closeTracked(fixture.service);
    const reopenedDatabase = await ContextDatabase.open({ path: fixture.databasePath });
    const reopened = new SqliteGitContextService({
      database: reopenedDatabase,
      dataRoot: fixture.root,
      workspaceRoot: fixture.workspaceRoot,
      now: () => at,
    });
    services.push(reopened);
    expect((await reopened.getActiveContext({ sessionId: fixture.sessionId }))
      .session?.attachments).toMatchObject({
        count: 1,
        recent: [{ sessionAssetId: "SA-report", storedPath: attachment.storedPath }],
      });
  });

  it("places same-name inputs without collision and commits only their manifest", async () => {
    const fixture = await createFixture();
    const first = await createAttachment(fixture.root, "data.csv", "value\n1\n", "SA-first");
    const second = await createAttachment(fixture.root, "data.csv", "value\n2\n", "SA-second");
    await record(fixture, [first, second]);
    const authority = await acquire(fixture, [{ path: "unused.txt", kind: "file" }]);

    const bound = await fixture.service.bindTaskAttachments({
      requestId: "REQ-bind-two",
      sessionId: fixture.sessionId,
      conversationId: fixture.conversationId,
      runId: fixture.runId,
      taskId: fixture.task.taskId,
      at,
    });
    expect(bound.references.map((reference) => reference.referenceId)).toEqual([
      "REF-0001",
      "REF-0002",
    ]);
    expect(new Set(bound.references.map((reference) => reference.location)).size).toBe(2);
    expect(await git(fixture.task.repositoryPath, ["status", "--porcelain"])).toBe("");
    expect((await validateTaskRepository({
      taskRoot: fixture.taskRoot,
      repositoryPath: fixture.task.repositoryPath,
    })).references).toEqual([]);

    await fixture.service.verifyMutation({
      requestId: "REQ-verify-two",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "completed",
      at,
    });
    await finalizeIncomplete(fixture, "REQ-finalize-two");

    const validation = await validateTaskRepository({
      taskRoot: fixture.taskRoot,
      repositoryPath: fixture.task.repositoryPath,
    });
    expect(validation.references).toHaveLength(2);
    expect(validation.references.map((reference) => reference.sha256)).toEqual([
      "sha256:" + first.checksum,
      "sha256:" + second.checksum,
    ]);
    expect((await git(fixture.task.repositoryPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
    ])).split("\n").sort()).toEqual([
      ".ayati/references.md",
      ".ayati/requests/R-0001-attachment-task.md",
      ".ayati/task.md",
    ]);
    expect(await readFile(join(fixture.task.repositoryPath, bound.references[0]!.location), "utf8"))
      .toBe("value\n1\n");
    expect(await readFile(join(fixture.task.repositoryPath, bound.references[1]!.location), "utf8"))
      .toBe("value\n2\n");
  });

  it("reports missing and changed ignored inputs when task context is reopened", async () => {
    const fixture = await createFixture();
    const first = await createAttachment(fixture.root, "first.csv", "value\n1\n", "SA-first");
    const second = await createAttachment(fixture.root, "second.csv", "value\n2\n", "SA-second");
    await record(fixture, [first, second]);
    const authority = await acquire(fixture, [{ path: "unused.txt", kind: "file" }]);
    const bound = await fixture.service.bindTaskAttachments({
      requestId: "REQ-bind-status",
      sessionId: fixture.sessionId,
      conversationId: fixture.conversationId,
      runId: fixture.runId,
      taskId: fixture.task.taskId,
      at,
    });
    await fixture.service.verifyMutation({
      requestId: "REQ-verify-status",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "completed",
      at,
    });
    await finalizeIncomplete(fixture, "REQ-finalize-status");
    await unlink(join(fixture.task.repositoryPath, bound.references[0]!.location));
    await writeFile(
      join(fixture.task.repositoryPath, bound.references[1]!.location),
      "changed after commit\n",
    );

    const context = await readSimpleTaskContext(fixture.task, {
      taskRoot: fixture.taskRoot,
      includeReferencesSummary: true,
    });
    expect(context.referencesSummary).toEqual({
      total: 2,
      available: 0,
      missing: 1,
      changed: 1,
      unchecked: 0,
    });
    expect(await git(fixture.task.repositoryPath, ["status", "--porcelain"])).toBe("");
  });

  it("adopts an attachment explicitly under mutation authority and preserves its original", async () => {
    const fixture = await createFixture();
    const attachment = await createAttachment(fixture.root, "settings.json", "{\"safe\":true}\n", "SA-settings");
    await record(fixture, [attachment]);
    const authority = await acquire(fixture, [{ path: "fixtures/settings.json", kind: "file" }]);
    const bound = await fixture.service.bindTaskAttachments({
      requestId: "REQ-bind-adopt",
      sessionId: fixture.sessionId,
      conversationId: fixture.conversationId,
      runId: fixture.runId,
      taskId: fixture.task.taskId,
      at,
    });
    const adopted = await fixture.service.adoptTaskReference({
      requestId: "REQ-adopt",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      referenceId: "REF-0001",
      destinationPath: "fixtures/settings.json",
      at,
    });
    expect(adopted).toMatchObject({
      sourcePath: bound.references[0]!.location,
      destinationPath: "fixtures/settings.json",
      sha256: "sha256:" + attachment.checksum,
    });
    await fixture.service.verifyMutation({
      requestId: "REQ-verify-adopt",
      authorityId: authority.authority.authorityId,
      lockToken: authority.authority.lockToken,
      toolStatus: "completed",
      at,
    });
    await finalizeIncomplete(fixture, "REQ-finalize-adopt");

    const validation = await validateTaskRepository({
      taskRoot: fixture.taskRoot,
      repositoryPath: fixture.task.repositoryPath,
    });
    expect(validation.references[0]).toMatchObject({
      id: "REF-0001",
      adoptedPath: "fixtures/settings.json",
      availability: "available",
    });
    expect(await readFile(join(fixture.task.repositoryPath, "fixtures/settings.json"), "utf8"))
      .toBe("{\"safe\":true}\n");
    expect(await readFile(join(fixture.task.repositoryPath, bound.references[0]!.location), "utf8"))
      .toBe("{\"safe\":true}\n");
    expect((await git(fixture.task.repositoryPath, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
    ])).split("\n").sort()).toContain("fixtures/settings.json");
  });

  it("allows the same retained attachment identity to be related to two tasks", async () => {
    const fixture = await createFixture();
    const attachment = await createAttachment(fixture.root, "shared.txt", "shared input\n", "SA-shared");
    await record(fixture, [attachment]);
    const firstAuthority = await acquire(fixture, [{ path: "unused.txt", kind: "file" }]);
    await fixture.service.bindTaskAttachments({
      requestId: "REQ-bind-first-task",
      sessionId: fixture.sessionId,
      conversationId: fixture.conversationId,
      runId: fixture.runId,
      taskId: fixture.task.taskId,
      at,
    });
    await fixture.service.verifyMutation({
      requestId: "REQ-verify-first-task",
      authorityId: firstAuthority.authority.authorityId,
      lockToken: firstAuthority.authority.lockToken,
      toolStatus: "completed",
      at,
    });
    await finalizeIncomplete(fixture, "REQ-finalize-first-task");

    const next = await fixture.service.prepareContextTurn({
      requestId: "REQ-next-turn",
      date: "2026-07-17",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Use the same retained input in another task.",
      at,
    });
    await fixture.service.recordSessionAttachments({
      requestId: "REQ-record-shared-again",
      sessionId: fixture.sessionId,
      conversationId: next.conversation.conversationId,
      attachments: [attachment],
      at,
    });
    const secondTask = await fixture.service.createTaskForRun({
      requestId: "REQ-second-task",
      sessionId: fixture.sessionId,
      conversationId: next.conversation.conversationId,
      runId: next.run.runId,
      title: "Second attachment task",
      objective: "Share one retained input without exclusive ownership.",
      placement: { mode: "managed" },
      at,
    });
    const secondAuthority = await fixture.service.acquireMutationAuthority({
      requestId: "REQ-second-authority",
      sessionId: fixture.sessionId,
      runId: next.run.runId,
      taskId: secondTask.task.taskId,
      taskRequestId: "R-0001",
      expectedTaskHead: secondTask.task.head,
      targets: [{ path: "unused.txt", kind: "file" }],
      at,
    });
    const secondBinding = await fixture.service.bindTaskAttachments({
      requestId: "REQ-bind-second-task",
      sessionId: fixture.sessionId,
      conversationId: next.conversation.conversationId,
      runId: next.run.runId,
      taskId: secondTask.task.taskId,
      at,
    });
    expect(secondBinding.references).toMatchObject([{
      sessionAssetId: "SA-shared",
      referenceId: "REF-0001",
    }]);
    expect(fixture.database.prepare([
      "SELECT COUNT(*) AS count FROM task_attachment_bindings",
      "WHERE session_asset_id = ?",
    ].join(" ")).get("SA-shared")).toEqual({ count: 2 });
    await fixture.service.verifyMutation({
      requestId: "REQ-verify-second-task",
      authorityId: secondAuthority.authority.authorityId,
      lockToken: secondAuthority.authority.lockToken,
      toolStatus: "failed",
      at,
    });
  });
});

interface Fixture {
  root: string;
  databasePath: string;
  workspaceRoot: string;
  taskRoot: string;
  database: ContextDatabase;
  service: SqliteGitContextService;
  sessionId: string;
  conversationId: string;
  runId: string;
  task: TaskCatalogEntry;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ayati-simple-attachments-"));
  temporaryDirectories.push(root);
  const databasePath = join(root, "context.db");
  const database = await ContextDatabase.open({ path: databasePath });
  const workspaceRoot = join(root, "workspace");
  const service = new SqliteGitContextService({
    database,
    dataRoot: root,
    workspaceRoot,
    now: () => at,
  });
  services.push(service);
  const prepared = await service.prepareContextTurn({
    requestId: "REQ-prepare-" + temporaryDirectories.length,
    date: "2026-07-17",
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: "Use the attached input in this task.",
    at,
  });
  const created = await service.createTaskForRun({
    requestId: "REQ-task-" + temporaryDirectories.length,
    sessionId: prepared.session.sessionId,
    conversationId: prepared.conversation.conversationId,
    runId: prepared.run.runId,
    title: "Attachment task",
    objective: "Persist attachment provenance without tracking private bytes.",
    placement: { mode: "managed" },
    at,
  });
  return {
    root,
    databasePath,
    workspaceRoot,
    taskRoot: join(workspaceRoot, "tasks"),
    database,
    service,
    sessionId: prepared.session.sessionId,
    conversationId: prepared.conversation.conversationId,
    runId: prepared.run.runId,
    task: created.task,
  };
}

async function createAttachment(
  root: string,
  name: string,
  content: string,
  sessionAssetId: string,
): Promise<SessionAttachmentRecord> {
  const directory = join(root, "retained", sessionAssetId);
  await mkdir(directory, { recursive: true });
  const storedPath = join(directory, name);
  await writeFile(storedPath, content);
  return {
    sessionAssetId,
    kind: "file",
    name,
    source: "user_upload",
    status: "ready",
    storedPath,
    sizeBytes: Buffer.byteLength(content),
    checksum: createHash("sha256").update(content).digest("hex"),
    createdAt: at,
    lastUsedAt: at,
  };
}

async function record(fixture: Fixture, attachments: SessionAttachmentRecord[]): Promise<void> {
  await fixture.service.recordSessionAttachments({
    requestId: "REQ-record-" + attachments.map((attachment) => attachment.sessionAssetId).join("-"),
    sessionId: fixture.sessionId,
    conversationId: fixture.conversationId,
    attachments,
    at,
  });
}

async function acquire(
  fixture: Fixture,
  targets: Array<{ path: string; kind: "file" | "directory" }>,
) {
  return await fixture.service.acquireMutationAuthority({
    requestId: "REQ-authority-" + targets[0]!.path,
    sessionId: fixture.sessionId,
    runId: fixture.runId,
    taskId: fixture.task.taskId,
    taskRequestId: "R-0001",
    expectedTaskHead: fixture.task.head,
    targets,
    at,
  });
}

async function finalizeIncomplete(fixture: Fixture, requestId: string): Promise<void> {
  await fixture.service.finalizeRun({
    requestId,
    sessionId: fixture.sessionId,
    runId: fixture.runId,
    outcome: "incomplete",
    stopReason: "run_limit",
    conversationSummary: "The task input was retained for later work.",
    summary: "The task now has a verified retained input reference.",
    validation: "not_applicable",
    next: "Continue using the retained input.",
    workState: {
      ...emptyWorkState(),
      summary: "The task now has a verified retained input reference.",
      nextStep: "Continue using the retained input.",
    },
    task: {
      completion: {
        accepted: false,
        assets: [],
        missing: ["Remaining task work"],
        failures: [],
        criteria: [{ criterion: "Complete the remaining task work.", passed: false }],
      },
    },
    assistantResponse: "The input is retained and linked to the task.",
    at,
  });
}

function emptyWorkState() {
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

async function closeTracked(service: SqliteGitContextService): Promise<void> {
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: repositoryPath, encoding: "utf8" });
  return result.stdout.trim();
}
